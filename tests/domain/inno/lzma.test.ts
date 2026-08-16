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
import { lzmaLargeSampleText, lzmaSampleText, pseudoRandomBytes } from "../../fixtures/lzmaSample"

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

  it("refuses a repeated match as the very first symbol, before anything was decoded", () => {
    // A range coder input of all-0xff bytes biases the very first bit
    // decisions towards 1 under the coder's initial (evenly split)
    // probabilities: "not a literal", then "it's a repeat of an earlier
    // distance" - except there is no earlier distance yet, nothing has been
    // decoded at all.
    const properties = new Uint8Array([0, 0, 0, 0, 0]) // lc=0, lp=0, pb=0
    const data = new Uint8Array(64).fill(0xff)
    data[0] = 0x00 // range coder header marker
    expect(() => decodeLzma1(properties, data, 1024)).toThrow(/a repeated match appears before anything was decoded/)
  })

  it("refuses a fresh match as the very first symbol, which can only reach before the stream started", () => {
    // Same idea, a different pair of first two bits: "not a literal", then
    // "a fresh distance, not a repeat of one already used" - a fresh match's
    // distance is checked against how much has been decoded so far, which at
    // the very first symbol is nothing at all, so any distance fails it.
    const properties = new Uint8Array([0, 0, 0, 0, 0])
    const data = new Uint8Array(64).fill(0xff)
    data[0] = 0x00 // range coder header marker
    data[1] = 0x80
    data[2] = 0x00
    data[3] = 0x00
    data[4] = 0x00
    expect(() => decodeLzma1(properties, data, 4096)).toThrow(/a match reaches 1 bytes back with only 0 decoded/)
  })

  it("decodes a stream past 64 KiB, growing the header dictionary's buffer past its first allocation", () => {
    const large = readFixture("sample-large.lzma1")
    const expectedLarge = Buffer.from(lzmaLargeSampleText(), "utf8")

    const decoded = decodeLzma1(large.subarray(0, 5), large.subarray(13), 64 * 1024 * 1024)

    expect(decoded.length).toBe(expectedLarge.length)
    expect(Buffer.from(decoded).equals(expectedLarge)).toBe(true)
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

  it("refuses a compressed chunk shorter than its range coder header", async () => {
    // control 0xe0: reset=3 (full reset, so a properties byte follows), output
    // size 1, input size 1 - one byte of "compressed" data, nowhere near the
    // five the range coder's own header needs.
    const stream = new Uint8Array([0xe0, 0, 0, 0, 0, 0, 0])
    await expect(decodeLzma2(stream, 22)).rejects.toThrow(/shorter than its range coder header/)
  })

  it("refuses an uncompressed chunk that carries on a dictionary nothing started", async () => {
    // Control 2 is an uncompressed chunk asking to CONTINUE the dictionary,
    // which cannot be the first thing in a stream either, the same way
    // control 0x80 cannot for a compressed one.
    const stream = new Uint8Array([2, 0, 0, 0x41])
    await expect(decodeLzma2(stream, 22)).rejects.toThrow(/never started/)
  })

  it("refuses a compressed chunk that resets its state before any properties were read", async () => {
    // An uncompressed chunk (control 1) can open a stream on its own,
    // resetting the dictionary without ever touching the LZMA model. A
    // compressed chunk with reset=1 (control 0xa0: state reset, no new
    // properties) right after it asks to reset a model whose lc/lp/pb were
    // never read in the first place.
    const opening = new Uint8Array([1, 0, 0, 0x41])
    const stateResetWithNoProperties = new Uint8Array([0xa0, 0, 0, 0, 0])
    const stream = new Uint8Array(opening.length + stateResetWithNoProperties.length)
    stream.set(opening, 0)
    stream.set(stateResetWithNoProperties, opening.length)

    await expect(decodeLzma2(stream, 22)).rejects.toThrow(/before any properties were read/)
  })

  it("refuses a compressed chunk that continues a state nothing ever set, after an uncompressed one only reset the dictionary", async () => {
    // An uncompressed chunk establishes the dictionary but never touches the
    // LZMA model at all. A compressed chunk with reset=0 (control 0x80: no
    // reset of anything) right after it asks to continue a model whose
    // lc/lp/pb were never read.
    const opening = new Uint8Array([1, 0, 0, 0x41])
    const continuing = new Uint8Array([0x80, 0, 0, 0, 0])
    const stream = new Uint8Array(opening.length + continuing.length)
    stream.set(opening, 0)
    stream.set(continuing, opening.length)

    const decoder = new Lzma2Decoder(22, () => undefined)
    const input = inputOver(stream)
    expect(await decoder.decodeChunk(input)).toBe(1)
    await expect(decoder.decodeChunk(input)).rejects.toThrow(/continues a state that was never started/)
  })

  it("refuses a chunk whose declared output runs a match past the end of its own bounds", async () => {
    // Trimming the declared output by a few bytes off a real, otherwise valid
    // chunk leaves a match mid-decode with nowhere left to land: the bytes it
    // would copy are real, there just is not enough declared room for all of
    // them.
    const stream = readFixture("sample.lzma2")
    const patched = Buffer.from(stream)
    const shrunkOutputSize = 40_079 - 10
    const encoded = shrunkOutputSize - 1
    patched[0] = 0x80 | (3 << 5) | ((encoded >>> 16) & 0x1f)
    patched[1] = (encoded >>> 8) & 0xff
    patched[2] = encoded & 0xff

    await expect(decodeLzma2(patched, 22)).rejects.toThrow(/runs past the end of its chunk/)
  })

  it("refuses a chunk claiming more output than its compressed bytes can actually produce", async () => {
    // sample.lzma2 is one real chunk, genuinely 40079 bytes out of 5343 bytes
    // in. Declaring ten times the output over the SAME compressed bytes runs
    // the range coder past what they hold, which the decoder has to notice
    // rather than hand back padding as though it were real data.
    const stream = readFixture("sample.lzma2")
    const patched = Buffer.from(stream)
    const inflatedOutputSize = 400_790
    const encoded = inflatedOutputSize - 1
    patched[0] = 0x80 | (3 << 5) | ((encoded >>> 16) & 0x1f)
    patched[1] = (encoded >>> 8) & 0xff
    patched[2] = encoded & 0xff

    await expect(decodeLzma2(patched, 22)).rejects.toThrow(/ended before the size it declared/)
  })

  it("stops on the terminating control byte", async () => {
    const decoder = new Lzma2Decoder(22, () => undefined)
    expect(await decoder.decodeChunk(inputOver(new Uint8Array([0])))).toBe(0)
    expect(decoder.finished).toBe(true)
  })

  it("answers 0 without touching the input again once it has already finished", async () => {
    const decoder = new Lzma2Decoder(22, () => undefined)
    const input = inputOver(new Uint8Array([0]))
    expect(await decoder.decodeChunk(input)).toBe(0)

    // A second call with no bytes left to read would throw if the decoder
    // tried to read them; answering 0 straight from `this.ended` is what
    // keeps a caller's "pump until finished" loop from ever reaching that.
    expect(await decoder.decodeChunk(input)).toBe(0)
  })

  it("decodes a stream split across more than one chunk, a later one resuming with no reset at all", async () => {
    const expectedLarge = Buffer.from(lzmaLargeSampleText(), "utf8")
    const decoded = await decodeLzma2(readFixture("sample-large.lzma2"), 22)

    expect(decoded.length).toBe(expectedLarge.length)
    expect(Buffer.from(decoded).equals(expectedLarge)).toBe(true)
  })

  it("wraps its ring dictionary many times over a text bigger than the dictionary itself", async () => {
    const expectedLarge = Buffer.from(lzmaLargeSampleText(), "utf8")
    // Property byte 0 names a 4 KiB dictionary, tiny next to the >2 MiB text:
    // the ring underneath has to wrap around dozens of times to produce it.
    const decoded = await decodeLzma2(readFixture("sample-small-dict.lzma2"), 0)

    expect(decoded.length).toBe(expectedLarge.length)
    expect(Buffer.from(decoded).equals(expectedLarge)).toBe(true)
  })

  it("decodes a stream that drops into genuinely uncompressed chunks and back", async () => {
    const compressibleHalf = Buffer.from(lzmaSampleText(), "utf8")
    const incompressible = pseudoRandomBytes(150_000, 7)
    const expected = Buffer.concat([compressibleHalf, incompressible, compressibleHalf])

    // Property byte 16 names the 1 MiB dictionary build-lzma-fixtures.ts asked
    // `xz` preset 1 for.
    const decoded = await decodeLzma2(readFixture("sample-mixed.lzma2"), 16)

    expect(decoded.length).toBe(expected.length)
    expect(Buffer.from(decoded).equals(expected)).toBe(true)
  })

  it("reuses an already big enough literal table across two full resets with matching properties", async () => {
    // Two independent streams, back to back, the first one's own terminating
    // control byte dropped so decodeChunk keeps going straight into the
    // second one's own reset=3 chunk: two separate setProperties calls with
    // the same lc/lp/pb, which is what lets the second one skip growing a
    // table that is already the right size.
    const stream = readFixture("sample.lzma2")
    const withoutTerminator = stream.subarray(0, stream.length - 1)
    const doubled = new Uint8Array(withoutTerminator.length + stream.length)
    doubled.set(withoutTerminator, 0)
    doubled.set(stream, withoutTerminator.length)

    const decoded = await decodeLzma2(doubled, 22)
    const once = Buffer.from(lzmaSampleText(), "utf8")

    expect(decoded.length).toBe(once.length * 2)
    expect(Buffer.from(decoded.subarray(0, once.length)).equals(once)).toBe(true)
    expect(Buffer.from(decoded.subarray(once.length)).equals(once)).toBe(true)
  })

  it("opens on an uncompressed chunk that resets the dictionary, before any compressed one ran", async () => {
    const compressibleHalf = Buffer.from(lzmaSampleText(), "utf8")
    const incompressible = pseudoRandomBytes(150_000, 7)
    const expected = Buffer.concat([incompressible, compressibleHalf])

    const decoded = await decodeLzma2(readFixture("sample-leading-random.lzma2"), 16)

    expect(decoded.length).toBe(expected.length)
    expect(Buffer.from(decoded).equals(expected)).toBe(true)
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
