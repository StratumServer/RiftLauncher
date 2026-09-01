import { InnoFormatError } from "@domain/inno/errors"
import { lzma2DictionarySize } from "@domain/inno/lzma"
import type { Lzma2DecoderFactory, Lzma2DecoderPort, Lzma2Input } from "@domain/inno/lzma"

type NativeDecompressStream = (input: ReadableStream<Uint8Array>, options: { dictSize: number }) => ReadableStream<Uint8Array>

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
  private readonly decompressStream: NativeDecompressStream
  private readonly dictionarySize: number
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private readonly pending: Uint8Array[] = []
  private pendingOffset = 0
  private pendingBytes = 0
  private sourceEnded = false
  private ended = false
  private sourceError: unknown
  private sourceFailed = false

  constructor(
    decompressStream: NativeDecompressStream,
    dictionarySizeProperties: number,
    private readonly onOutput: (bytes: Uint8Array) => void
  ) {
    try {
      this.dictionarySize = lzma2DictionarySize(dictionarySizeProperties)
    } catch {
      throw new NativeLzma2Error("the native LZMA2 decoder could not be created")
    }

    this.decompressStream = decompressStream
  }

  private createReader(input: Lzma2Input): ReadableStreamDefaultReader<Uint8Array> {
    const source = new ReadableStream<Uint8Array>({
      pull: async (controller): Promise<void> => {
        try {
          const control = (await input.readExactly(1))[0]!
          if (control === 0) {
            controller.enqueue(Uint8Array.of(0))
            controller.close()
            return
          }

          controller.enqueue(await readFrame(input, control))
        } catch (error) {
          this.sourceError = error
          this.sourceFailed = true
          controller.error(error)
        }
      }
    })

    try {
      return this.decompressStream(source, { dictSize: this.dictionarySize }).getReader()
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
      // The domain's fixed staging buffer can reject an oversized native
      // output chunk. Stop the stream before the caller retries the block.
      void this.close()
      throw new NativeLzma2Error("the native LZMA2 decoder produced an oversized chunk")
    }
  }

  async close(): Promise<void> {
    if (this.ended) return
    this.ended = true
    const reader = this.reader
    if (reader) await reader.cancel().catch(() => undefined)
  }

  /**
   * Stream output is owned by the Web Streams queue, so it can be retained
   * while the staging buffer drains without copying the decoded block.
   */
  private queue(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    this.pending.push(bytes)
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
    this.reader ??= this.createReader(input)
    try {
      const result = await this.reader.read()
      if (result.done) {
        this.sourceEnded = true
        this.ended = true
        return 0
      }
      this.queue(result.value)
      return this.flushPending()
    } catch (error) {
      if (this.sourceFailed) throw this.sourceError
      throw new NativeLzma2Error("the native LZMA2 decoder rejected the stream")
    }
  }
}

export function createNativeLzma2DecoderFactory(decompressStream: NativeDecompressStream): Lzma2DecoderFactory {
  return (dictionarySizeProperties, onOutput) => new NativeLzma2Decoder(decompressStream, dictionarySizeProperties, onOutput)
}

let nativeFactory: Promise<Lzma2DecoderFactory | undefined> | undefined

/** Loads the optional platform binary once; an unsupported platform uses TypeScript unchanged. */
export function loadNativeLzma2DecoderFactory(): Promise<Lzma2DecoderFactory | undefined> {
  nativeFactory ??= (async (): Promise<Lzma2DecoderFactory | undefined> => {
    try {
      const { decompressStream } = await import("@napi-rs/lzma/lzma2")
      return createNativeLzma2DecoderFactory(decompressStream)
    } catch {
      return undefined
    }
  })()
  return nativeFactory
}
