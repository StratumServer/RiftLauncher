import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import { runInnoExtraction } from "../../src/ipc/workers/innoExtraction"

/**
 * These run against the tiny installers tests/fixtures/build-inno-fixtures.ts
 * builds, so they need neither a network nor Windows.
 *
 * The one test that needs a real Vintage Story installer is opt in: point
 * RIFT_E2E_INNO at a downloaded `vs_install_win-x64_<version>.exe` to run it,
 * the same shape as RIFT_E2E_ARCHIVE in extraction.test.ts. CI never does.
 */

const FIXTURES = join(__dirname, "../fixtures/inno")

let workspace: string

function workspacePath(...parts: string[]): string {
  return join(workspace, ...parts)
}

/** Copies a fixture in, since an extraction may be asked to delete its installer. */
function installerFrom(name: string): string {
  const path = workspacePath(name)
  copyFileSync(join(FIXTURES, name), path)
  return path
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-inno-test-"))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("runInnoExtraction", () => {
  it("lays the payload down in the target folder", async () => {
    const outcome = await runInnoExtraction({ filePath: installerFrom("valid.bin"), outputPath: workspacePath("target"), deleteInstaller: false })

    assert.equal(outcome.verdict, "extracted")
    assert.equal(outcome.filesWritten, 2)
    assert.deepEqual(readdirSync(workspacePath("target")).sort(), ["Vintagestory.exe", "assets"])
    assert.equal(readFileSync(workspacePath("target", "Vintagestory.exe"), "utf8"), "MZ fake executable\n")
    assert.equal(readFileSync(workspacePath("target", "assets", "version-1.0.0.txt"), "utf8"), "1.0.0\n")
  })

  it("reports progress from zero to a hundred", async () => {
    const reported: number[] = []
    await runInnoExtraction({ filePath: installerFrom("valid.bin"), outputPath: workspacePath("target"), deleteInstaller: false, onProgress: (progress) => reported.push(progress) })

    assert.equal(reported.at(-1), 100)
    assert.equal(
      reported.every((progress) => progress >= 0 && progress <= 100),
      true
    )
  })

  it("consumes the installer when asked to", async () => {
    const installerPath = installerFrom("valid.bin")
    await runInnoExtraction({ filePath: installerPath, outputPath: workspacePath("target"), deleteInstaller: true })

    assert.equal(existsSync(installerPath), false)
    assert.equal(existsSync(workspacePath("target", "Vintagestory.exe")), true)
  })

  it("keeps the installer when not asked to", async () => {
    const installerPath = installerFrom("valid.bin")
    await runInnoExtraction({ filePath: installerPath, outputPath: workspacePath("target"), deleteInstaller: false })

    assert.equal(existsSync(installerPath), true)
  })

  it("extracts an LZMA2 payload through the native decoder when available", async () => {
    const outcome = await runInnoExtraction({ filePath: installerFrom("lzma2-payload.bin"), outputPath: workspacePath("target"), deleteInstaller: false })

    assert.equal(outcome.verdict, "extracted")
    assert.equal(readFileSync(workspacePath("target", "first-compressed.txt"), "utf8"), "lzma2 first file, compressed for real\n".repeat(20))
    assert.equal(readFileSync(workspacePath("target", "second-compressed.txt"), "utf8"), "lzma2 second file, sharing the same solid block\n".repeat(20))
  })

  it("reports a refused format instead of failing, so the caller can run the installer", async () => {
    const outcome = await runInnoExtraction({ filePath: installerFrom("unsupported-version.bin"), outputPath: workspacePath("target"), deleteInstaller: false })

    assert.equal(outcome.verdict, "format-refused")
    assert.match(String(outcome.reason), /6\.5\.0/)
    assert.deepEqual(readdirSync(workspacePath("target")), [])
  })

  it("writes nothing into the target when a checksum does not land", async () => {
    const outcome = await runInnoExtraction({ filePath: installerFrom("bad-block-crc.bin"), outputPath: workspacePath("target"), deleteInstaller: true })

    assert.equal(outcome.verdict, "format-refused")
    assert.deepEqual(readdirSync(workspacePath("target")), [])
    // A refused installer is left where it is: the caller is about to run it.
    assert.equal(existsSync(workspacePath("bad-block-crc.bin")), true)
  })

  it("writes nothing into the target when a destination climbs out of it", async () => {
    const outcome = await runInnoExtraction({ filePath: installerFrom("path-traversal.bin"), outputPath: workspacePath("target"), deleteInstaller: false })

    assert.equal(outcome.verdict, "format-refused")
    assert.deepEqual(readdirSync(workspacePath("target")), [])
    assert.equal(existsSync(workspacePath("escaped.txt")), false)
  })

  it("refuses a destination reached through a symbolic link", async () => {
    mkdirSync(workspacePath("real"))
    symlinkSync(workspacePath("real"), workspacePath("link"))

    await assert.rejects(runInnoExtraction({ filePath: installerFrom("valid.bin"), outputPath: workspacePath("link", "target"), deleteInstaller: false }), /Symbolic links are not allowed/)
  })

  it("leaves no temporary folder behind, whatever happened", async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("riftlauncher-inno-")).length

    await runInnoExtraction({ filePath: installerFrom("valid.bin"), outputPath: workspacePath("target"), deleteInstaller: false })
    await runInnoExtraction({ filePath: installerFrom("wrong-digest.bin"), outputPath: workspacePath("other"), deleteInstaller: false })

    assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith("riftlauncher-inno-")).length, before)
  })
})

/**
 * The real thing. Set RIFT_E2E_INNO to a downloaded Windows installer and
 * RIFT_E2E_VERSION to its version to run it:
 *
 * RIFT_E2E_INNO=/tmp/vs_install_win-x64_1.22.6.exe RIFT_E2E_VERSION=1.22.6 npm test
 *
 * The payload is platform independent, so this runs on Linux: what it proves is
 * that the format reader agrees with the installer, not that Windows is happy.
 * Every file it writes was checked against the SHA-256 the installer declares
 * for it before it was written, so the count landing is the digests landing.
 */
const realInstaller = process.env.RIFT_E2E_INNO
describe.skipIf(!realInstaller)("runInnoExtraction on a real Vintage Story installer", () => {
  it("puts the game executable and the version marker straight in the target folder", { timeout: 900_000 }, async () => {
    const version = process.env.RIFT_E2E_VERSION ?? ""
    const started = Date.now()

    const outcome = await runInnoExtraction({ filePath: realInstaller as string, outputPath: workspacePath("target"), deleteInstaller: false })

    assert.equal(outcome.verdict, "extracted")
    assert.equal(statSync(workspacePath("target", "Vintagestory.exe")).size > 0, true)
    assert.equal(lstatSync(workspacePath("target", "assets")).isDirectory(), true)
    if (version) assert.equal(existsSync(workspacePath("target", "assets", `version-${version}.txt`)), true)

    // Printed rather than asserted: the count and the timing are the record the
    // pull request quotes, and pinning either would make a new game release fail
    // a test that has nothing to say about the reader.
    console.log(`extracted ${outcome.filesWritten} files, ${outcome.bytesWritten} bytes, in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    console.log(
      `Vintagestory.exe sha256 ${createHash("sha256")
        .update(readFileSync(workspacePath("target", "Vintagestory.exe")))
        .digest("hex")}`
    )
  })
})
