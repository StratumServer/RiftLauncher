import { InnoFormatError } from "@domain/inno/errors"
import { lzma2DictionarySize } from "@domain/inno/lzma"
import type { Lzma2DecoderFactory, Lzma2DecoderPort, Lzma2Input } from "@domain/inno/lzma"

interface NativeDecompressor {
  update(input: Uint8Array): Uint8Array
  finish(): Promise<Uint8Array>
}

interface NativeDecompressorConstructor {
  new (options: { dictSize: number }): NativeDecompressor
}

/** Keep each callback within the domain stream's fixed staging buffer. */
const NATIVE_OUTPUT_BYTES = 2 * 1024 * 1024

/** A native codec failure that is safe to retry with the TypeScript decoder. */
export class NativeLzma2Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NativeLzma2Error"
  }
}

export function isNativeLzma2Error(error: unknown): error is NativeLzma2Error {
  return error instanceof NativeLzma2Error
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const joined = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

async function readFrame(input: Lzma2Input, control: number): Promise<Uint8Array> {
  if (control < 3) {
    const header = Uint8Array.from(await input.readExactly(2))
    const size = ((header[0]! << 8) | header[1]!) + 1
    return join([Uint8Array.of(control), header, await input.readExactly(size)])
  }

  if (control < 0x80) throw InnoFormatError.corrupt(`invalid LZMA2 control byte (${control})`)

  const header = Uint8Array.from(await input.readExactly(4))
  const inputSize = ((header[2]! << 8) | header[3]!) + 1
  const reset = (control >>> 5) & 3
  const properties = reset >= 2 ? Uint8Array.from(await input.readExactly(1)) : new Uint8Array(0)

  return join([Uint8Array.of(control), header, properties, await input.readExactly(inputSize)])
}

class NativeLzma2Decoder implements Lzma2DecoderPort {
  private readonly decoder: NativeDecompressor
  private readonly pending: Uint8Array[] = []
  private pendingOffset = 0
  private pendingBytes = 0
  private sourceEnded = false
  private ended = false

  constructor(
    Decompressor: NativeDecompressorConstructor,
    dictionarySizeProperties: number,
    private readonly onOutput: (bytes: Uint8Array) => void
  ) {
    try {
      this.decoder = new Decompressor({ dictSize: lzma2DictionarySize(dictionarySizeProperties) })
    } catch {
      throw new NativeLzma2Error("the native LZMA2 decoder could not be created")
    }
  }

  get finished(): boolean {
    return this.ended
  }

  private emit(bytes: Uint8Array): void {
    try {
      this.onOutput(bytes)
    } catch {
      // The domain's fixed staging buffer can reject a native decoder that
      // buffered more than one LZMA2 chunk. Let the caller retry that block
      // with the TypeScript decoder, which emits one chunk at a time.
      throw new NativeLzma2Error("the native LZMA2 decoder produced an oversized chunk")
    }
  }

  /**
   * `owned` says the bytes are ours to keep. The library documents `update()`
   * as handing back a zero-copy view, so that one is copied before a later call
   * can write over it. `finish()` resolves to the decoded tail and leaves a
   * spent decoder behind, so nothing can rewrite it, and on a solid block the
   * copy would be a second copy of the entire block.
   */
  private queue(bytes: Uint8Array, owned = false): void {
    if (bytes.length === 0) return
    this.pending.push(owned ? bytes : Uint8Array.from(bytes))
    this.pendingBytes += bytes.length
  }

  private flushPending(): number {
    if (this.pendingBytes === 0) {
      if (this.sourceEnded) this.ended = true
      return 0
    }

    const first = this.pending[0]!
    const available = first.length - this.pendingOffset
    const take = Math.min(available, NATIVE_OUTPUT_BYTES)
    this.emit(first.subarray(this.pendingOffset, this.pendingOffset + take))
    this.pendingOffset += take
    this.pendingBytes -= take

    if (this.pendingOffset === first.length) {
      this.pending.shift()
      this.pendingOffset = 0
    }
    if (this.pendingBytes === 0 && this.sourceEnded) this.ended = true
    return take
  }

  async decodeChunk(input: Lzma2Input): Promise<number> {
    if (this.ended) return 0
    if (this.pendingBytes > 0) return this.flushPending()
    if (this.sourceEnded) {
      this.ended = true
      return 0
    }

    const control = (await input.readExactly(1))[0]!
    if (control === 0) {
      try {
        this.queue(this.decoder.update(Uint8Array.of(0)))
        this.queue(await this.decoder.finish(), true)
      } catch {
        throw new NativeLzma2Error("the native LZMA2 decoder rejected the stream")
      }
      this.sourceEnded = true
      return this.flushPending()
    }

    const frame = await readFrame(input, control)
    try {
      this.queue(this.decoder.update(frame))
    } catch {
      throw new NativeLzma2Error("the native LZMA2 decoder rejected a chunk")
    }
    return this.flushPending()
  }
}

export function createNativeLzma2DecoderFactory(Decompressor: NativeDecompressorConstructor): Lzma2DecoderFactory {
  return (dictionarySizeProperties, onOutput) => new NativeLzma2Decoder(Decompressor, dictionarySizeProperties, onOutput)
}

let nativeFactory: Promise<Lzma2DecoderFactory | undefined> | undefined

/** Loads the optional platform binary once; an unsupported platform uses TypeScript unchanged. */
export function loadNativeLzma2DecoderFactory(): Promise<Lzma2DecoderFactory | undefined> {
  nativeFactory ??= (async (): Promise<Lzma2DecoderFactory | undefined> => {
    try {
      const { Decompressor } = await import("@napi-rs/lzma/lzma2")
      return createNativeLzma2DecoderFactory(Decompressor)
    } catch {
      return undefined
    }
  })()
  return nativeFactory
}
