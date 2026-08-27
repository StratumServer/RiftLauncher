import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface FakePorts {
  sink: {
    writeFile(relativePath: string, contents: Uint8Array): Promise<void>
  }
}

interface FakeOptions {
  lzma2DecoderFactory?: unknown
}

let attempts = 0

vi.mock("@src/domain/inno/extract", () => ({
  extractInnoPayload: async (ports: FakePorts, options: FakeOptions): Promise<{ version: string; compression: "lzma2"; filesWritten: number; bytesWritten: number }> => {
    attempts++
    if (options.lzma2DecoderFactory) {
      await ports.sink.writeFile("partial.txt", Uint8Array.of(1))
      throw new Error("native failure")
    }

    await ports.sink.writeFile("final.txt", Uint8Array.of(2))
    return { version: "6.4.3", compression: "lzma2", filesWritten: 1, bytesWritten: 1 }
  }
}))

vi.mock("@src/ipc/workers/nativeLzma2", () => ({
  isNativeLzma2Error: (error: unknown): boolean => error instanceof Error && error.message === "native failure",
  loadNativeLzma2DecoderFactory: async (): Promise<() => Record<string, never>> => () => ({})
}))

import { runInnoExtraction } from "@src/ipc/workers/innoExtraction"

let workspace: string

beforeEach(() => {
  attempts = 0
  workspace = mkdtempSync(join(tmpdir(), "rift-inno-native-cleanup-"))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("native LZMA2 fallback cleanup", () => {
  it("removes files written by a failed native attempt before retrying", async () => {
    const installer = join(workspace, "installer.bin")
    const target = join(workspace, "target")
    writeFileSync(installer, "fixture")

    const outcome = await runInnoExtraction({ filePath: installer, outputPath: target, deleteInstaller: false })

    expect(outcome.verdict).toBe("extracted")
    expect(attempts).toBe(2)
    expect(readFileSync(join(target, "final.txt"))).toEqual(Buffer.from([2]))
    expect(existsSync(join(target, "partial.txt"))).toBe(false)
  })
})
