import { describe, expect, it } from "vitest"

import { createNativeLzma2DecoderFactory } from "@src/ipc/workers/nativeLzma2"

function inputOver(bytes: Uint8Array): { readExactly(length: number): Promise<Uint8Array> } {
  let at = 0
  return {
    readExactly: async (length): Promise<Uint8Array> => {
      if (at + length > bytes.length) throw new Error("out of input")
      const slice = bytes.subarray(at, at + length)
      at += length
      return slice
    }
  }
}

function inputWithScratch(bytes: Uint8Array): { readExactly(length: number): Promise<Uint8Array> } {
  let at = 0
  const scratch = new Uint8Array(4)
  return {
    readExactly: async (length): Promise<Uint8Array> => {
      if (length > scratch.length || at + length > bytes.length) throw new Error("out of input")
      scratch.set(bytes.subarray(at, at + length))
      at += length
      return scratch.subarray(0, length)
    }
  }
}

describe("native LZMA2 adapter", () => {
  it("copies frame headers before reading the following payload", async () => {
    let received: Uint8Array | undefined
    class CapturingDecompressor {
      update(input: Uint8Array): Uint8Array {
        received = Uint8Array.from(input)
        return new Uint8Array(0)
      }

      async finish(): Promise<Uint8Array> {
        return new Uint8Array(0)
      }
    }

    const factory = createNativeLzma2DecoderFactory(CapturingDecompressor)
    const decoder = factory(0, () => {})
    await decoder.decodeChunk(inputWithScratch(Uint8Array.from([0xa0, 0, 0, 0, 1, 0x11, 0x22])))

    expect(received).toEqual(Uint8Array.from([0xa0, 0, 0, 0, 1, 0x11, 0x22]))
  })

  it("assembles output correctly when the decoder reuses its update buffer", async () => {
    // The library returns update() output as a zero-copy view, so a later call
    // may write over bytes the adapter is still holding. finish() hands back the
    // tail of a spent decoder, which is why that one is queued without a copy.
    const reused = new Uint8Array(4)
    let call = 0
    class ReusingDecompressor {
      update(): Uint8Array {
        reused.fill(++call)
        return reused
      }

      async finish(): Promise<Uint8Array> {
        reused.fill(0xff)
        return Uint8Array.of(0xaa, 0xbb)
      }
    }

    const pieces: Uint8Array[] = []
    const factory = createNativeLzma2DecoderFactory(ReusingDecompressor)
    const decoder = factory(0, (bytes) => pieces.push(bytes.slice()))
    const input = inputOver(Uint8Array.from([0xa0, 0, 0, 0, 1, 0x11, 0x22, 0xa0, 0, 0, 0, 1, 0x33, 0x44, 0]))
    while (!decoder.finished) await decoder.decodeChunk(input)

    expect(Buffer.concat(pieces.map((piece) => Buffer.from(piece)))).toEqual(Buffer.from([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 0xaa, 0xbb]))
  })

  it("drains buffered native output in bounded pieces", async () => {
    const expected = new Uint8Array(5 * 1024 * 1024 + 123)
    expected.fill(7)
    const pieces: Uint8Array[] = []
    class BufferedDecompressor {
      update(input: Uint8Array): Uint8Array {
        return input.length === 1 && input[0] === 0 ? new Uint8Array(0) : expected
      }

      async finish(): Promise<Uint8Array> {
        return new Uint8Array(0)
      }
    }

    const factory = createNativeLzma2DecoderFactory(BufferedDecompressor)
    const decoder = factory(0, (bytes) => pieces.push(bytes.slice()))
    const input = inputOver(Uint8Array.from([0xa0, 0, 0, 0, 1, 0x11, 0x22, 0]))
    while (!decoder.finished) await decoder.decodeChunk(input)

    expect(pieces.reduce((total, piece) => total + piece.length, 0)).toBe(expected.length)
    expect(pieces.every((piece) => piece.length <= 2 * 1024 * 1024)).toBe(true)
    expect(Buffer.concat(pieces.map((piece) => Buffer.from(piece))).equals(Buffer.from(expected))).toBe(true)
  })
})
