import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

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
  vi.unstubAllEnvs()
  // Without this, a spy planted on the shared fse module (the cleanup-failure tests below)
  // outlives its own test and reaches whatever runs after it in this file, opt-in real
  // installer run included.
  vi.restoreAllMocks()
})

describe("runInnoExtraction", () => {
  it("lays the payload down in the target folder", async () => {
    const outcome = await runInnoExtraction({ filePath: installerFrom("valid.bin"), outputPath: workspacePath("target"), deleteInstaller: false })

    assert.equal(outcome.verdict, "extracted")
    assert.equal(outcome.filesWritten, 2)
    assert.deepEqual(readdirSync(workspacePath("target")).sort(), ["Vintagestory.exe", "assets"])
    assert.equal(readFileSync(workspacePath("target", "Vintagestory.exe"), "utf8"), "MZ fake executable\n")
    assert.equal(readFileSync(workspacePath("target", "assets", "version-1.0.0.txt"), "utf8"), "1.0.0\n")
    // Mutants M11/M13: nothing else in this file checks that a clean run comes back
    // without a cleanup warning attached.
    assert.equal(outcome.cleanupWarning, undefined)
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
    const outcome = await runInnoExtraction({ filePath: installerPath, outputPath: workspacePath("target"), deleteInstaller: true })

    assert.equal(existsSync(installerPath), false)
    assert.equal(existsSync(workspacePath("target", "Vintagestory.exe")), true)
    // Mutants M11/M13: nothing else in this file checks that a clean run comes back
    // without a cleanup warning attached.
    assert.equal(outcome.cleanupWarning, undefined)
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
    // Staging goes wherever the temp root points, and the machine-wide one is
    // shared with everything else running: counting folders by name there counts
    // the ones other runs are still using. These two calls get a temp root to
    // themselves, so whatever is left in it at the end is theirs.
    const temporaryRoot = workspacePath("temp-root")
    mkdirSync(temporaryRoot)
    vi.stubEnv("TMPDIR", temporaryRoot)
    vi.stubEnv("TMP", temporaryRoot)
    vi.stubEnv("TEMP", temporaryRoot)

    await runInnoExtraction({ filePath: installerFrom("valid.bin"), outputPath: workspacePath("target"), deleteInstaller: false })
    await runInnoExtraction({ filePath: installerFrom("wrong-digest.bin"), outputPath: workspacePath("other"), deleteInstaller: false })

    assert.deepEqual(readdirSync(temporaryRoot), [])
  })
})

/**
 * Issue #528. Once copyTree has landed the game, the two cleanup calls left
 * (deleting the installer, removing the temporary staging folder in the
 * finally block) must not turn that landed install into a failure: a handle
 * held on either path, most often a Windows scanner reacting to files that
 * were just written, is not this install's problem. Both are exercised
 * separately here, each against the tiny valid.bin fixture rather than a real
 * installer, since the mechanism under test is what happens after copyTree
 * returns, not the copy itself.
 */
describe("runInnoExtraction: post-copy cleanup is best-effort", () => {
  it("still reports extracted, with a warning, when deleting the installer throws after the copy landed", async () => {
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked, unlink"), { code: "EBUSY" })
    })

    const outcome = await runInnoExtraction({ filePath: installerFrom("valid.bin"), outputPath: workspacePath("target"), deleteInstaller: true })

    assert.equal(outcome.verdict, "extracted")
    assert.deepEqual(outcome.cleanupWarning, { reason: "installer-delete-failed", code: "EBUSY" })
    assert.equal(existsSync(workspacePath("target", "Vintagestory.exe")), true)
  })

  it("still reports extracted, with a warning, when the installer is gone by the time it is checked before deletion (antivirus quarantine)", async () => {
    // The player report behind this: an antivirus quarantined the freshly written installer
    // between the copy landing and the pre-delete safety check, so lstatSync itself throws
    // ENOENT rather than unlinkSync. Scoped to the installer path only, since the same spy
    // sits under this file's own lstatSync(outputPath) symlink check earlier in the run.
    const installerPath = installerFrom("valid.bin")
    const fse = (await import("fs-extra")).default
    const realLstatSync = fse.lstatSync.bind(fse)
    vi.spyOn(fse, "lstatSync").mockImplementation((path: Parameters<typeof fse.lstatSync>[0]) => {
      if (path === installerPath) throw Object.assign(new Error("ENOENT: no such file or directory, lstat"), { code: "ENOENT" })
      return realLstatSync(path)
    })

    const outcome = await runInnoExtraction({ filePath: installerPath, outputPath: workspacePath("target"), deleteInstaller: true })

    assert.equal(outcome.verdict, "extracted")
    assert.deepEqual(outcome.cleanupWarning, { reason: "installer-delete-failed", code: "ENOENT" })
    assert.equal(existsSync(workspacePath("target", "Vintagestory.exe")), true)
  })

  it("still reports extracted, with a warning, when removing the staging folder throws after the copy landed", async () => {
    // mkdtempSync goes wherever TMPDIR/TMP/TEMP point (see "leaves no temporary folder
    // behind" above). Pinning it inside workspace means the riftlauncher-inno-* folder
    // this run creates and then fails to remove is swept up by afterEach's
    // rmSync(workspace), not left behind in the machine-wide os.tmpdir() every run of
    // this file shares.
    const temporaryRoot = workspacePath("temp-root")
    mkdirSync(temporaryRoot)
    vi.stubEnv("TMPDIR", temporaryRoot)
    vi.stubEnv("TMP", temporaryRoot)
    vi.stubEnv("TEMP", temporaryRoot)

    const fse = (await import("fs-extra")).default
    const rmSpy = vi.spyOn(fse, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted, rmdir"), { code: "EPERM" })
    })

    const outcome = await runInnoExtraction({ filePath: installerFrom("valid.bin"), outputPath: workspacePath("target"), deleteInstaller: false })

    assert.equal(outcome.verdict, "extracted")
    assert.deepEqual(outcome.cleanupWarning, { reason: "staging-cleanup-failed", code: "EPERM" })
    assert.equal(existsSync(workspacePath("target", "Vintagestory.exe")), true)
    // #528's Windows half: the staging removal went from removeSync's plain rmSync to one
    // with retries, giving a scanner time to let go of a handle on a file just written.
    const options = rmSpy.mock.calls[0]?.[1]
    assert.equal((options?.maxRetries ?? 0) > 0, true)
    assert.equal((options?.retryDelay ?? 0) > 0, true)
  })

  it("stays fatal when the destination cannot be created before any copy has happened", async () => {
    // Control: a failure that never reaches copyTree still rejects, same as before #528.
    // Not a cleanup call at all, but it pins that the best-effort change stayed scoped to
    // after a successful copy, not to every throw runInnoExtraction can produce.
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "ensureDirSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied, mkdir"), { code: "EACCES" })
    })

    await assert.rejects(runInnoExtraction({ filePath: installerFrom("valid.bin"), outputPath: workspacePath("target"), deleteInstaller: false }), /EACCES/)
  })

  it("surfaces the original verdict, not the staging removal error, when a format-refused run's cleanup also throws", async () => {
    // #527 regression guard: before this round, a removal error in the finally block
    // replaced whatever the try block had already decided, turning a plain format-refused
    // (the everyday "run the installer instead" signal) into a hard failure and skipping
    // the spawn fallback entirely.
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted, rmdir"), { code: "EPERM" })
    })

    const outcome = await runInnoExtraction({ filePath: installerFrom("unsupported-version.bin"), outputPath: workspacePath("target"), deleteInstaller: false })

    assert.equal(outcome.verdict, "format-refused")
    assert.match(String(outcome.reason), /6\.5\.0/)
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
