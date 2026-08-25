import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { loadNativeLzma2DecoderFactory } from "@src/ipc/workers/nativeLzma2"
import { lzmaLargeSampleText, lzmaSampleText, pseudoRandomBytes } from "../fixtures/lzmaSample"

const FIXTURES = join(__dirname, "../fixtures/inno")

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

async function decodeNative(bytes: Uint8Array, properties: number): Promise<Uint8Array> {
  const factory = await loadNativeLzma2DecoderFactory()
  if (!factory) throw new Error("native LZMA2 binary is not available")

  const pieces: Uint8Array[] = []
  const decoder = factory(properties, (output) => pieces.push(output.slice()))
  const input = inputOver(bytes)
  while (!decoder.finished) await decoder.decodeChunk(input)
  return Buffer.concat(pieces.map((piece) => Buffer.from(piece)))
}

describe("native LZMA2 decoder", () => {
  it.each([
    ["sample.lzma2", 22, Buffer.from(lzmaSampleText(), "utf8")],
    ["sample-large.lzma2", 22, Buffer.from(lzmaLargeSampleText(), "utf8")],
    ["sample-small-dict.lzma2", 0, Buffer.from(lzmaLargeSampleText(), "utf8")],
    ["sample-mixed.lzma2", 16, Buffer.concat([Buffer.from(lzmaSampleText(), "utf8"), pseudoRandomBytes(150_000, 7), Buffer.from(lzmaSampleText(), "utf8")])],
    ["sample-leading-random.lzma2", 16, Buffer.concat([pseudoRandomBytes(150_000, 7), Buffer.from(lzmaSampleText(), "utf8")])]
  ] as const)(
    "matches the generated plaintext for %s",
    async (name, properties, expected) => {
      const fixture = new Uint8Array(readFileSync(join(FIXTURES, name)))
      const native = await decodeNative(fixture, properties)

      expect(Buffer.from(native).equals(expected)).toBe(true)
    },
    30_000
  )
})
