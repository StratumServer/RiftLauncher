/**
 * The extractor against whole installers, built byte by byte by
 * tests/fixtures/build-inno-fixtures.ts.
 *
 * One fixture is well formed and is read end to end. The rest each break one
 * thing, and every one of them has to be refused rather than half read: a
 * reader that guesses its way past a bad checksum or a path climbing out of the
 * folder is worse than no reader at all, because what it produces looks like a
 * game.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { extractInnoPayload } from "@domain/inno/extract"
import { InnoFormatError } from "@domain/inno/errors"
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

describe("extractInnoPayload", () => {
  it("lays down every entry destined for the version folder, and only those", async () => {
    const { ports, written } = harnessFor("valid.bin")

    const result = await extractInnoPayload(ports)

    expect(result.version).toBe("6.4.3")
    expect(result.compression).toBe("stored")
    expect(result.filesWritten).toBe(2)
    expect([...written.keys()].sort()).toEqual(["Vintagestory.exe", "assets/version-1.0.0.txt"])
    expect(textOf(written, "Vintagestory.exe")).toBe("MZ fake executable\n")
    expect(textOf(written, "assets/version-1.0.0.txt")).toBe("1.0.0\n")
    expect(result.bytesWritten).toBe("MZ fake executable\n".length + "1.0.0\n".length)
  })

  it("reports progress once the work is done", async () => {
    const { ports } = harnessFor("valid.bin")
    const reported: number[] = []

    await extractInnoPayload(ports, { onProgress: (fraction) => reported.push(fraction) })

    expect(reported.length).toBeGreaterThan(0)
    expect(reported.at(-1)).toBe(1)
  })

  it("refuses a file that ends in the middle of a block", async () => {
    const { ports, written } = harnessFor("truncated-header.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(InnoFormatError)
    expect(written.size).toBe(0)
  })

  it("refuses a block whose chunk checksum does not land", async () => {
    const { ports, written } = harnessFor("bad-block-crc.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/CRC32 of a block chunk/)
    expect(written.size).toBe(0)
  })

  it("refuses a destination that climbs out of the version folder", async () => {
    const { ports, written } = harnessFor("path-traversal.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/outside the version folder/)
    expect(written.size).toBe(0)
  })

  it("refuses an entry that declares more bytes than a game file could hold", async () => {
    const { ports, written } = harnessFor("oversized-entry.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/an entry of 3221225472 bytes/)
    expect(written.size).toBe(0)
  })

  it("refuses a file whose digest is not the one the installer declares", async () => {
    const { ports, written } = harnessFor("wrong-digest.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/SHA-256/)
    expect(written.size).toBe(0)
  })

  it("refuses a data format version it does not claim to read", async () => {
    const { ports } = harnessFor("unsupported-version.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/setup data format 6.5.0/)
  })

  it("refuses an installer with nothing destined for the version folder", async () => {
    const { ports } = harnessFor("no-app-files.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(/no file destined/)
  })

  it("refuses a version whose record layout does not match what the file holds", async () => {
    const { ports, written } = harnessFor("mismatched-layout.bin")
    await expect(extractInnoPayload(ports)).rejects.toThrow(InnoFormatError)
    expect(written.size).toBe(0)
  })

  it("refuses a file with no loader in it at all", async () => {
    const bytes = new Uint8Array(4096)
    const ports: InnoExtractionPorts = {
      installer: { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) },
      digest: { hash: (contents) => new Uint8Array(createHash("sha256").update(contents).digest()) },
      sink: { writeFile: async () => undefined }
    }

    await expect(extractInnoPayload(ports)).rejects.toThrow(/no Inno Setup loader/)
  })
})
