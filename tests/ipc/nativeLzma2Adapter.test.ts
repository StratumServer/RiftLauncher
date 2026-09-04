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

/** A fake native stream that exposes each framed input chunk as one output chunk. */
function echoFrames(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = input.getReader()
  return new ReadableStream({
    async pull(controller): Promise<void> {
      const result = await reader.read()
      if (result.done || (result.value.length === 1 && result.value[0] === 0)) controller.close()
      else controller.enqueue(result.value)
    }
  })
}

describe("native LZMA2 adapter", () => {
  it("copies frame headers before reading the following payload", async () => {
    let received: Uint8Array | undefined
    const factory = createNativeLzma2DecoderFactory(echoFrames)
    const decoder = factory(0, (bytes) => {
      received = Uint8Array.from(bytes)
    })

    await decoder.decodeChunk(inputWithScratch(Uint8Array.from([0xa0, 0, 0, 0, 1, 0x11, 0x22])))

    expect(received).toEqual(Uint8Array.from([0xa0, 0, 0, 0, 1, 0x11, 0x22]))
  })

  it("assembles streamed output in order and stops at the LZMA2 terminator", async () => {
    const pieces: Uint8Array[] = []
    const factory = createNativeLzma2DecoderFactory(echoFrames)
    const decoder = factory(0, (bytes) => pieces.push(bytes.slice()))
    const input = inputOver(Uint8Array.from([0xa0, 0, 0, 0, 1, 0x11, 0x22, 0xa0, 0, 0, 0, 1, 0x33, 0x44, 0]))

    while (!decoder.finished) await decoder.decodeChunk(input)

    expect(Buffer.concat(pieces.map((piece) => Buffer.from(piece)))).toEqual(Buffer.from([0xa0, 0, 0, 0, 1, 0x11, 0x22, 0xa0, 0, 0, 0, 1, 0x33, 0x44]))
  })

  it("cancels the native reader when closed before the source ends", async () => {
    let cancelled = false
    const factory = createNativeLzma2DecoderFactory(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(Uint8Array.of(1))
          },
          cancel(): void {
            cancelled = true
          }
        })
    )
    const decoder = factory(0, () => {})

    await decoder.decodeChunk(inputOver(new Uint8Array(0)))
    await decoder.close?.()

    expect(cancelled).toBe(true)
  })

  it("drains buffered native output in bounded pieces", async () => {
    const expected = new Uint8Array(5 * 1024 * 1024 + 123)
    expected.fill(7)
    const pieces: Uint8Array[] = []
    const factory = createNativeLzma2DecoderFactory(
      () =>
        new ReadableStream({
          start(controller): void {
            controller.enqueue(expected)
            controller.close()
          }
        })
    )
    const decoder = factory(0, (bytes) => pieces.push(bytes.slice()))

    while (!decoder.finished) await decoder.decodeChunk(inputOver(new Uint8Array(0)))

    expect(pieces.reduce((total, piece) => total + piece.length, 0)).toBe(expected.length)
    expect(pieces.every((piece) => piece.length <= 2 * 1024 * 1024)).toBe(true)
    expect(Buffer.concat(pieces.map((piece) => Buffer.from(piece))).equals(Buffer.from(expected))).toBe(true)
  })
})
