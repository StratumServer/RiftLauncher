import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Records whether the native reader was cancelled. The flag is reset before
 * each mock stream is created so the test can assert it after extraction.
 */
let readerCancelled = false
let resolvePull: (() => void) | undefined

vi.mock("@napi-rs/lzma/lzma2", () => ({
  decompressStream: (): ReadableStream<Uint8Array> => {
    readerCancelled = false
    resolvePull = undefined
    return new ReadableStream<Uint8Array>({
      pull(controller): Promise<void> {
        // Produce a chunk large enough for the fixture's first entry (760
        // bytes) but with content that does not match the SHA-256 digests,
        // so verifyDigest fails and the block is abandoned partway. The
        // stream stays open so close() must cancel it rather than finding it
        // already finished.
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x41))
        return new Promise<void>((resolve) => {
          resolvePull = resolve
        })
      },
      cancel(): void {
        readerCancelled = true
        resolvePull?.()
      }
    })
  }
}))

import { runInnoExtraction } from "@src/ipc/workers/innoExtraction"

const FIXTURE = join(__dirname, "../fixtures/inno/lzma2-payload.bin")
let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-inno-close-wiring-"))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("native LZMA2 close wiring", () => {
  it("cancels the native reader when the extractor closes the stream", async () => {
    const installer = join(workspace, "installer.bin")
    const target = join(workspace, "target")
    copyFileSync(FIXTURE, installer)

    // The mock produces output that does not match the fixture's SHA-256
    // digests, so the extraction fails on the first verifyDigest call. That
    // failure propagates through the try block in writePlan, whose finally
    // calls stream.close(). The chain is ChunkStream.close ->
    // NativeLzma2Decoder.close -> reader.cancel, and the mock's cancel
    // handler records that call.
    const outcome = await runInnoExtraction({ filePath: installer, outputPath: target, deleteInstaller: false })

    expect(outcome.verdict).toBe("format-refused")
    expect(readerCancelled).toBe(true)
  })
})
