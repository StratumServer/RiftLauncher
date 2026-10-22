import { afterEach, describe, expect, it, vi } from "vitest"

import { awaitNativeSettle, createNativeLzma2DecoderFactory, NATIVE_SETTLE_MS } from "@src/ipc/workers/nativeLzma2"

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

  // Ending the worker thread right after the cancel aborts the launcher with napi 3.10.5 (#758): the
  // addon's task is still dropping its callbacks into the thread when the thread goes.
  describe("settling after a cancel (#758)", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    function openMidStream(): ReturnType<ReturnType<typeof createNativeLzma2DecoderFactory>> {
      const factory = createNativeLzma2DecoderFactory(
        () =>
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(Uint8Array.of(1))
            }
          })
      )
      return factory(0, () => {})
    }

    // Fake clocks start at the real time, so a deadline an earlier test recorded could still be ahead.
    function startFakeClock(): void {
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 60_000)
    }

    async function waitsFor(settle: Promise<void>, ms: number): Promise<void> {
      let done = false
      void settle.then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(ms - 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await settle
      expect(done).toBe(true)
    }

    it("returns from close without waiting, and leaves the settle to awaitNativeSettle", async () => {
      startFakeClock()
      const decoder = openMidStream()
      await decoder.decodeChunk(inputOver(new Uint8Array(0)))

      await decoder.close?.()
      expect(vi.getTimerCount()).toBe(0)

      await waitsFor(awaitNativeSettle(), NATIVE_SETTLE_MS)
    })

    it("pays the settle once for many cancelled streams, not once per stream", async () => {
      startFakeClock()
      for (let index = 0; index < 5; index++) {
        const decoder = openMidStream()
        await decoder.decodeChunk(inputOver(new Uint8Array(0)))
        await decoder.close?.()
        await vi.advanceTimersByTimeAsync(10)
      }

      // The last cancel was 10 ms ago, so 90 ms remain, not 5 x 100.
      await waitsFor(awaitNativeSettle(), NATIVE_SETTLE_MS - 10)
    })

    it("does not wait in awaitNativeSettle once the settle time has passed on its own", async () => {
      startFakeClock()
      const decoder = openMidStream()
      await decoder.decodeChunk(inputOver(new Uint8Array(0)))
      await decoder.close?.()
      await vi.advanceTimersByTimeAsync(NATIVE_SETTLE_MS)

      await awaitNativeSettle()

      expect(vi.getTimerCount()).toBe(0)
    })

    it("does not wait in awaitNativeSettle when nothing was cancelled", async () => {
      startFakeClock()
      vi.setSystemTime(Date.now() + 60_000)

      await awaitNativeSettle()

      expect(vi.getTimerCount()).toBe(0)
    })

    it("stops pulling input once closed, even when the addon's pump holds the stream", async () => {
      let nativeInput: ReadableStream<Uint8Array> | undefined
      const reads: number[] = []
      const factory = createNativeLzma2DecoderFactory((input) => {
        nativeInput = input
        // A pump that is mid-pull cannot be cancelled: the output stream stays open here.
        return new ReadableStream<Uint8Array>({ pull: (): Promise<void> => new Promise<void>(() => undefined) })
      })
      const decoder = factory(0, () => {})
      const frames = { readExactly: async (length: number): Promise<Uint8Array> => (reads.push(length), length === 1 ? Uint8Array.of(1) : new Uint8Array(length)) }
      void decoder.decodeChunk(frames)
      await vi.waitFor(() => expect(nativeInput).toBeDefined())

      const pumpReader = nativeInput!.getReader()
      expect((await pumpReader.read()).done).toBe(false)

      await decoder.close?.()

      await expect(pumpReader.read()).rejects.toThrow(/closed/)
    })

    it("close waits for a pull that is already reading the installer", async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let nativeInput: ReadableStream<Uint8Array> | undefined
      const factory = createNativeLzma2DecoderFactory((input) => {
        nativeInput = input
        return new ReadableStream<Uint8Array>({ pull: (): Promise<void> => new Promise<void>(() => undefined) })
      })
      const decoder = factory(0, () => {})
      const frames = { readExactly: async (length: number): Promise<Uint8Array> => (await gate, length === 1 ? Uint8Array.of(0) : new Uint8Array(length)) }
      void decoder.decodeChunk(frames)
      await vi.waitFor(() => expect(nativeInput).toBeDefined())

      let closed = false
      const closing = decoder.close?.().then(() => {
        closed = true
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      expect(closed).toBe(false)

      release()
      await closing
      expect(closed).toBe(true)
    })

    it("does not wait when the stream already ended", async () => {
      startFakeClock()
      const factory = createNativeLzma2DecoderFactory(
        () =>
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.close()
            }
          })
      )
      const decoder = factory(0, () => {})
      while (!decoder.finished) await decoder.decodeChunk(inputOver(new Uint8Array(0)))

      await decoder.close?.()

      expect(vi.getTimerCount()).toBe(0)
    })

    it("does not wait when no native stream was ever opened", async () => {
      startFakeClock()

      await openMidStream().close?.()

      expect(vi.getTimerCount()).toBe(0)
    })
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
