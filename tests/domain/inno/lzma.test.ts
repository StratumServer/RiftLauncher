/**
 * The LZMA decoder against streams a real compressor produced.
 *
 * The fixtures come from `xz` through tests/fixtures/build-lzma-fixtures.ts, and
 * the expected plaintext is regenerated here from the same seed, so a decoder
 * that drifts cannot take the expectation with it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { decodeLzma1, Lzma2Decoder, lzma2DictionarySize } from "@domain/inno/lzma"
import { InnoFormatError } from "@domain/inno/errors"
import { lzmaSampleText } from "../../fixtures/lzmaSample"

const FIXTURES = join(__dirname, "../../fixtures/inno")

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

/** Feeds a whole buffer to the LZMA2 decoder one requested run at a time. */
function inputOver(bytes: Uint8Array): { readExactly(length: number): Promise<Uint8Array> } {
  let at = 0
  return {
    readExactly: async (length: number): Promise<Uint8Array> => {
      if (at + length > bytes.length) throw new Error("out of input")
      const slice = bytes.subarray(at, at + length)
      at += length
      return slice
    }
  }
}

async function decodeLzma2(bytes: Uint8Array, dictionaryProperties: number): Promise<Uint8Array> {
  const pieces: Uint8Array[] = []
  const decoder = new Lzma2Decoder(dictionaryProperties, (produced) => pieces.push(produced.slice()))
  const input = inputOver(bytes)

  while (!decoder.finished) {
    if ((await decoder.decodeChunk(input)) === 0) break
  }

  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const output = new Uint8Array(total)
  let at = 0
  for (const piece of pieces) {
    output.set(piece, at)
    at += piece.length
  }
  return output
}

describe("decodeLzma1", () => {
  const expected = Buffer.from(lzmaSampleText(), "utf8")

  it("decodes a raw stream that stores neither its length nor an end marker", () => {
    const alone = readFixture("sample.lzma1")
    // The .lzma container is five property bytes then an eight byte size. The
    // size is dropped on purpose: a header block does not carry one, and the
    // decoder has to stop when its input stops.
    const decoded = decodeLzma1(alone.subarray(0, 5), alone.subarray(13), 64 * 1024 * 1024)

    expect(decoded.length).toBe(expected.length)
    expect(Buffer.from(decoded).equals(expected)).toBe(true)
  })

  it("refuses a property header shorter than five bytes", () => {
    expect(() => decodeLzma1(new Uint8Array(4), new Uint8Array(64), 1024)).toThrow(InnoFormatError)
  })

  it("refuses a stream that does not open on a range coder header", () => {
    const alone = readFixture("sample.lzma1")
    const body = alone.slice(13)
    body[0] = 0x01
    expect(() => decodeLzma1(alone.subarray(0, 5), body, 64 * 1024 * 1024)).toThrow(/range coder header/)
  })

  it("refuses a block that decompresses past the bound it was given", () => {
    const alone = readFixture("sample.lzma1")
    expect(() => decodeLzma1(alone.subarray(0, 5), alone.subarray(13), 1024)).toThrow(/decompressed past/)
  })

  it("refuses an invalid properties byte", () => {
    const properties = new Uint8Array([9 * 5 * 5, 0, 0, 0, 0])
    expect(() => decodeLzma1(properties, new Uint8Array(16), 1024)).toThrow(/invalid LZMA properties/)
  })
})

describe("Lzma2Decoder", () => {
  const expected = Buffer.from(lzmaSampleText(), "utf8")

  it("decodes a raw stream chunk by chunk", async () => {
    // Preset 6 asks for an 8 MiB dictionary, which the format names with 22.
    const decoded = await decodeLzma2(readFixture("sample.lzma2"), 22)

    expect(decoded.length).toBe(expected.length)
    expect(Buffer.from(decoded).equals(expected)).toBe(true)
  })

  it("decodes the same bytes with a dictionary larger than the one that compressed them", async () => {
    const decoded = await decodeLzma2(readFixture("sample.lzma2"), 26)
    expect(Buffer.from(decoded).equals(expected)).toBe(true)
  })

  it("refuses a chunk whose control byte names no shape the format has", async () => {
    const stream = new Uint8Array([0x7f, 0, 0, 0])
    await expect(decodeLzma2(stream, 22)).rejects.toThrow(/invalid LZMA2 control byte/)
  })

  it("refuses a chunk that carries on a dictionary nothing started", async () => {
    // Control 0x80 is an LZMA chunk asking for no reset at all, which cannot be
    // the first thing in a stream.
    const stream = new Uint8Array([0x80, 0, 0, 0, 0])
    await expect(decodeLzma2(stream, 22)).rejects.toThrow(/never started/)
  })

  it("stops on the terminating control byte", async () => {
    const decoder = new Lzma2Decoder(22, () => undefined)
    expect(await decoder.decodeChunk(inputOver(new Uint8Array([0])))).toBe(0)
    expect(decoder.finished).toBe(true)
  })
})

describe("lzma2DictionarySize", () => {
  it("reads the sizes the format can name", () => {
    expect(lzma2DictionarySize(0)).toBe(4096)
    expect(lzma2DictionarySize(18)).toBe(2 * 1024 * 1024)
    expect(lzma2DictionarySize(22)).toBe(8 * 1024 * 1024)
  })

  it("refuses a byte outside the range the format defines", () => {
    expect(() => lzma2DictionarySize(41)).toThrow(/invalid LZMA2 dictionary size/)
  })

  it("refuses a dictionary too large to be one an installer asked for", () => {
    expect(() => lzma2DictionarySize(40)).toThrow(InnoFormatError)
    expect(() => lzma2DictionarySize(38)).toThrow(/dictionary of/)
  })
})
