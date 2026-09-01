import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@napi-rs/lzma/lzma2", () => ({
  decompressStream: () => {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1))
        queueMicrotask(() => controller.error(new Error("simulated native decoder failure")))
      }
    })
  }
}))

import { runInnoExtraction } from "@src/ipc/workers/innoExtraction"

const FIXTURE = join(__dirname, "../fixtures/inno/lzma2-payload.bin")
let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-inno-native-fallback-"))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("native LZMA2 fallback", () => {
  it("restarts extraction after partial native output and cleans the failed attempt", async () => {
    const installer = join(workspace, "installer.bin")
    const target = join(workspace, "target")
    copyFileSync(FIXTURE, installer)

    const outcome = await runInnoExtraction({ filePath: installer, outputPath: target, deleteInstaller: false })

    expect(outcome.verdict).toBe("extracted")
    expect(readFileSync(join(target, "first-compressed.txt"), "utf8")).toBe("lzma2 first file, compressed for real\n".repeat(20))
    expect(readFileSync(join(target, "second-compressed.txt"), "utf8")).toBe("lzma2 second file, sharing the same solid block\n".repeat(20))
    expect(readdirSync(target).sort()).toEqual(["first-compressed.txt", "second-compressed.txt"])
  })
})
