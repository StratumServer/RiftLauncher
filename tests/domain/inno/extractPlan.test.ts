/**
 * extractInnoPayload against the fixtures build-inno-fixtures.ts builds for
 * scenarios the original valid.bin never exercised: several destinations
 * consuming one data entry, destinations that dedupe by lowercase, several
 * data chunks in one installer, an empty file tied for its offset with the
 * one after it, and whole installers genuinely built at 6.4.0 and 6.4.2
 * rather than only ever 6.4.3.
 *
 * Same harness as extract.test.ts: everything downstream of the raw bytes
 * stays real, only the installer/digest/sink ports are faked.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { extractInnoPayload } from "@domain/inno/extract"
import { Lzma2Decoder } from "@domain/inno/lzma"
import type { Lzma2DecoderFactory, Lzma2Input } from "@domain/inno/lzma"
import type { InnoExtractionPorts } from "@domain/inno/ports"

const FIXTURES = join(__dirname, "../../fixtures/inno")

interface Harness {
  ports: InnoExtractionPorts
  written: Map<string, Uint8Array>
}

function harnessFor(name: string): Harness {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)))
  const written = new Map<string, Uint8Array>()

  return {
    written,
    ports: {
      installer: {
        size: bytes.length,
        read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length))
      },
      digest: { hash: (contents) => new Uint8Array(createHash("sha256").update(contents).digest()) },
      sink: {
        writeFile: async (relativePath, contents): Promise<void> => {
          written.set(relativePath, contents.slice())
        }
      }
    }
  }
}

function textOf(written: Map<string, Uint8Array>, path: string): string {
  return Buffer.from(written.get(path) ?? new Uint8Array()).toString("utf8")
}

describe("extractInnoPayload: one data entry, several destinations", () => {
  it("writes the same bytes out to every destination that shares a location", async () => {
    const { ports, written } = harnessFor("multi-destination.bin")
    const result = await extractInnoPayload(ports)

    expect(result.filesWritten).toBe(2)
    expect([...written.keys()].sort()).toEqual(["A.txt", "nested/B.txt"])
    expect(textOf(written, "A.txt")).toBe("shared bytes\n")
    expect(textOf(written, "nested/B.txt")).toBe("shared bytes\n")
  })
})

describe("extractInnoPayload: destinations that dedupe by case", () => {
  it("writes the entry once when two destinations differ only by case", async () => {
    const { ports, written } = harnessFor("duplicate-destination-case.bin")
    const result = await extractInnoPayload(ports)

    expect(result.filesWritten).toBe(1)
    expect(written.size).toBe(1)
  })
})

describe("extractInnoPayload: several data chunks", () => {
  it("closes one chunk and opens the next rather than reading past it", async () => {
    const { ports, written } = harnessFor("multi-chunk.bin")
    const result = await extractInnoPayload(ports)

    expect(result.filesWritten).toBe(2)
    expect(textOf(written, "first.txt")).toBe("first chunk contents\n")
    expect(textOf(written, "second.txt")).toBe("second chunk contents\n")
  })
})

describe("extractInnoPayload: an empty file tied for its offset", () => {
  it("writes both the empty file and the one it shares an offset with", async () => {
    const { ports, written } = harnessFor("empty-file-tie-break.bin")
    const result = await extractInnoPayload(ports)

    expect(result.filesWritten).toBe(2)
    expect(written.get("empty.txt")).toHaveLength(0)
    expect(textOf(written, "filled.txt")).toBe("not empty\n")
  })
})

describe("extractInnoPayload: genuinely valid installers at 6.4.0 and 6.4.2", () => {
  it("extracts a 6.4.0 installer end to end", async () => {
    const { ports, written } = harnessFor("valid-6.4.0.bin")
    const result = await extractInnoPayload(ports)

    expect(result.version).toBe("6.4.0")
    expect(result.filesWritten).toBe(2)
    expect(textOf(written, "Vintagestory.exe")).toBe("MZ fake executable\n")
  })

  it("extracts a 6.4.2 installer end to end", async () => {
    const { ports, written } = harnessFor("valid-6.4.2.bin")
    const result = await extractInnoPayload(ports)

    expect(result.version).toBe("6.4.2")
    expect(result.filesWritten).toBe(2)
    expect(textOf(written, "Vintagestory.exe")).toBe("MZ fake executable\n")
  })
})

describe("extractInnoPayload: entries the planner has to skip before a real one", () => {
  it("skips a file Setup builds itself and one naming a location that does not exist", async () => {
    const { ports, written } = harnessFor("unused-location-entries.bin")
    const result = await extractInnoPayload(ports)

    expect(result.filesWritten).toBe(1)
    expect(textOf(written, "kept.txt")).toBe("kept bytes\n")
  })
})

describe("extractInnoPayload: an encrypted entry", () => {
  it("refuses it outright", async () => {
    const { ports, written } = harnessFor("encrypted-entry.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/encrypted data/)
    expect(written.size).toBe(0)
  })
})

describe("extractInnoPayload: a call-instruction-optimized entry", () => {
  it("undoes the filter before writing the file", async () => {
    const { ports, written } = harnessFor("call-optimized-entry.bin")
    const result = await extractInnoPayload(ports)

    expect(result.filesWritten).toBe(1)
    // The compiler stored an absolute address of 5 at a CALL/JMP opcode's
    // offset 0; undone, that is a relative displacement of zero.
    expect([...written.get("filtered.bin")!]).toEqual([0xe8, 0x00, 0x00, 0x00, 0x00])
  })
})

describe("extractInnoPayload: a digest of the wrong length", () => {
  it("refuses it before comparing a single byte", async () => {
    // The format itself always declares exactly 32 bytes for a digest, so the
    // only way to build this case is a `digest` port that answers something
    // else, the way an unexpected hash implementation would.
    const { ports, written } = harnessFor("valid.bin")
    const shortHashPorts: InnoExtractionPorts = { ...ports, digest: { hash: () => new Uint8Array(16) } }

    await expect(extractInnoPayload(shortHashPorts)).rejects.toThrow(/wrong length/)
    expect(written.size).toBe(0)
  })
})

describe("extractInnoPayload: a skipped entry sitting between two kept ones", () => {
  it("discards the skipped bytes rather than reading them as the next file", async () => {
    const { ports, written } = harnessFor("gap-between-entries.bin")
    const result = await extractInnoPayload(ports)

    expect(result.filesWritten).toBe(2)
    expect(textOf(written, "first.txt")).toBe("first\n")
    expect(textOf(written, "second.txt")).toBe("second\n")
  })
})

describe("extractInnoPayload: a location table whose declared offsets run backwards", () => {
  it("refuses it rather than read past where the first entry ended", async () => {
    const { ports, written } = harnessFor("out-of-order-offsets.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/do not follow each other/)
    // The first entry in stream order is legitimate on its own and gets
    // written before the second one's offset is found to run backwards:
    // extraction is not transactional, so the refusal is what stops it going
    // further, not a promise that nothing landed at all.
    expect(written.has("b.bin")).toBe(false)
  })
})

describe("extractInnoPayload: a data block missing its marker", () => {
  it("refuses it", async () => {
    const { ports, written } = harnessFor("bad-chunk-magic.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/missing its marker/)
    expect(written.size).toBe(0)
  })
})

describe("extractInnoPayload: a genuinely LZMA2-compressed payload", () => {
  it("decompresses a solid block shared by two files", async () => {
    const { ports, written } = harnessFor("lzma2-payload.bin")
    const result = await extractInnoPayload(ports)

    expect(result.compression).toBe("lzma2")
    expect(result.filesWritten).toBe(2)
    expect(textOf(written, "first-compressed.txt")).toBe("lzma2 first file, compressed for real\n".repeat(20))
    expect(textOf(written, "second-compressed.txt")).toBe("lzma2 second file, sharing the same solid block\n".repeat(20))
  })

  it("reports progress as it decompresses", async () => {
    const { ports } = harnessFor("lzma2-payload.bin")
    const reported: number[] = []

    await extractInnoPayload(ports, { onProgress: (fraction) => reported.push(fraction) })

    expect(reported.length).toBeGreaterThan(0)
    expect(reported.at(-1)).toBe(1)
  })
})

describe("extractInnoPayload: a decoder that reports nothing for several calls before flushing", () => {
  it("keeps pumping the decoder rather than giving up the first time nothing comes back", async () => {
    // Mimics what the native adapter does: `decodeChunk` gets called several
    // times in a row producing nothing, then hands everything over at once.
    // The pre-fix pump called `decodeChunk` exactly once per read and treated
    // an empty first call as the stream ending; this decoder would trip that
    // immediately, since it never emits anything before its fifth call.
    const { ports, written } = harnessFor("lzma2-payload.bin")
    let calls = 0

    const lzma2DecoderFactory: Lzma2DecoderFactory = (dictionaryProperties, onOutput) => {
      const buffered: Uint8Array[] = []
      const inner = new Lzma2Decoder(dictionaryProperties, (bytes) => buffered.push(Uint8Array.from(bytes)))

      return {
        get finished(): boolean {
          return inner.finished && buffered.length === 0
        },
        async decodeChunk(input: Lzma2Input): Promise<number> {
          calls++
          if (!inner.finished) {
            await inner.decodeChunk(input)
            return 0
          }
          if (calls < 5) return 0

          let total = 0
          for (const bytes of buffered.splice(0)) {
            onOutput(bytes)
            total += bytes.length
          }
          return total
        }
      }
    }

    const result = await extractInnoPayload(ports, { lzma2DecoderFactory })

    expect(calls).toBeGreaterThanOrEqual(5)
    expect(result.filesWritten).toBe(2)
    expect(textOf(written, "first-compressed.txt")).toBe("lzma2 first file, compressed for real\n".repeat(20))
    expect(textOf(written, "second-compressed.txt")).toBe("lzma2 second file, sharing the same solid block\n".repeat(20))
  })
})

describe("extractInnoPayload: a skipped entry inside a solid LZMA2 block", () => {
  it("discards the decoded gap rather than hand it out as the next file", async () => {
    const { ports, written } = harnessFor("lzma2-gap.bin")
    const result = await extractInnoPayload(ports)

    expect(result.filesWritten).toBe(2)
    expect(textOf(written, "lzma2-first.txt")).toBe("kept first, lzma2 solid block\n".repeat(20))
    expect(textOf(written, "lzma2-second.txt")).toBe("kept second, after the gap\n".repeat(20))
  })
})

describe("extractInnoPayload: a solid LZMA2 block that opens on a skipped entry", () => {
  it("discards straight off the stream before it has read anything at all", async () => {
    const { ports, written } = harnessFor("lzma2-leading-gap.bin")
    const result = await extractInnoPayload(ports)

    expect(result.filesWritten).toBe(1)
    expect(textOf(written, "kept-after-gap.txt")).toBe("kept, after the leading gap\n".repeat(20))
  })
})

describe("extractInnoPayload: progress reporting that would repeat a percentage", () => {
  it("does not report the same rounded percentage twice in a row", async () => {
    const { ports } = harnessFor("progress-plateau.bin")
    const reported: number[] = []

    await extractInnoPayload(ports, { onProgress: (fraction) => reported.push(Math.floor(fraction * 100)) })

    for (let i = 1; i < reported.length; i++) expect(reported[i]).not.toBe(reported[i - 1])
    expect(reported.at(-1)).toBe(100)
  })
})

describe("extractInnoPayload: a declared size the compressed stream cannot deliver", () => {
  it("refuses it once the LZMA2 stream ends with the entry still short", async () => {
    const { ports, written } = harnessFor("lzma2-declared-oversized.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/data stream ended before the entries it declares/)
    expect(written.size).toBe(0)
  })
})

describe("extractInnoPayload: a compressed entry under a method this reader does not decode", () => {
  it("refuses zlib compressed data rather than attempt it", async () => {
    const { ports, written } = harnessFor("zlib-compressed-entry.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/zlib compressed data/)
    expect(written.size).toBe(0)
  })
})
