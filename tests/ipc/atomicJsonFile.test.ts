import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"

/**
 * writeJsonAtomic, the shared persistence adapter behind config, account secrets, the
 * mod-catalog disk cache, the game's own settings file, and modpack export. Two concerns:
 * does the adapter call write-file-atomic correctly (JSON shape, mode, overwrite), and does
 * the crash guarantee it exists for actually hold against the real dependency, not just its
 * documentation.
 *
 * The crash cases spawn tests/fixtures/atomicJsonFileCrashChild.ts under tsx, which runs
 * src/ipc/atomicJsonFile.ts itself (not write-file-atomic directly) and self-SIGKILLs at a
 * chosen point via a patched fs.rename. That means these trials prove the shipped adapter is
 * crash-safe, not only the dependency it wraps. SIGKILL is uncatchable and skips all cleanup,
 * the closest simulation of a real crash or power loss available in-process; execFileSync
 * throwing is the expected shape of "the child died by signal" and is not itself a test
 * failure.
 */

let temporaryRoot: string

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "atomic-json-file-test-"))
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

describe("writeJsonAtomic", () => {
  it("writes readable JSON that round-trips", async () => {
    const dest = join(temporaryRoot, "doc.json")

    await writeJsonAtomic(dest, { hello: "world", n: 3 })

    assert.deepEqual(JSON.parse(readFileSync(dest, "utf8")), { hello: "world", n: 3 })
  })

  it("overwrites existing content rather than merging or appending", async () => {
    const dest = join(temporaryRoot, "doc.json")
    writeFileSync(dest, JSON.stringify({ old: true }))

    await writeJsonAtomic(dest, { fresh: true })

    assert.deepEqual(JSON.parse(readFileSync(dest, "utf8")), { fresh: true })
  })

  it.skipIf(process.platform === "win32")("applies the requested mode to the destination", () => {
    // Windows has no POSIX mode bits to assert; this is a Unix-only guarantee, and the
    // account store's own explicit chmod (accountStore.ts) is the cross-platform belt for it.
    const dest = join(temporaryRoot, "secret.json")

    return writeJsonAtomic(dest, { k: "v" }, { mode: 0o600 }).then(() => {
      assert.equal(statSync(dest).mode & 0o777, 0o600)
    })
  })

  it("leaves no temp file behind on success", async () => {
    const dest = join(temporaryRoot, "doc.json")

    await writeJsonAtomic(dest, { ok: true })

    const leftovers = readdirSync(temporaryRoot).filter((name) => name !== "doc.json")
    assert.deepEqual(leftovers, [])
  })
})

describe("writeJsonAtomic crash safety (real write-file-atomic, real SIGKILL)", () => {
  const repoRoot = join(__dirname, "../..")

  function runCrashChild(destPath: string, killAt: "before-rename" | "after-rename"): void {
    try {
      execFileSync(process.execPath, ["--import", "tsx", join(__dirname, "../fixtures/atomicJsonFileCrashChild.ts"), destPath, killAt], { cwd: repoRoot, stdio: "ignore" })
    } catch {
      // Expected: the child dies by SIGKILL on every trial.
    }
  }

  it("keeps the previous good file intact when the crash lands before rename", () => {
    const dest = join(temporaryRoot, "config.json")
    writeFileSync(dest, JSON.stringify({ marker: "OLD-CONTENT" }))
    chmodSync(dest, 0o644)

    runCrashChild(dest, "before-rename")

    assert.equal(existsSync(dest), true, "the destination must never be observed missing")
    assert.deepEqual(JSON.parse(readFileSync(dest, "utf8")), { marker: "OLD-CONTENT" })
  }, 20_000)

  it("lands the new file when the crash happens after rename completes", () => {
    const dest = join(temporaryRoot, "config.json")
    writeFileSync(dest, JSON.stringify({ marker: "OLD-CONTENT" }))

    runCrashChild(dest, "after-rename")

    assert.equal(existsSync(dest), true)
    assert.deepEqual(JSON.parse(readFileSync(dest, "utf8")), { marker: "NEW-CONTENT" })
  }, 20_000)

  it("never observes the destination missing across repeated crashes before rename", () => {
    // Repeats the single-trial case enough times to rule out one lucky run: every one of
    // these is a real child process, a real write-file-atomic call through the real
    // adapter, and a real SIGKILL.
    const dest = join(temporaryRoot, "config.json")

    for (let trial = 0; trial < 10; trial++) {
      writeFileSync(dest, JSON.stringify({ marker: "OLD-CONTENT" }))
      runCrashChild(dest, "before-rename")
      assert.equal(existsSync(dest), true, `trial ${trial}: destination missing`)
      assert.deepEqual(JSON.parse(readFileSync(dest, "utf8")), { marker: "OLD-CONTENT" }, `trial ${trial}: destination corrupted`)
    }
  }, 60_000)
})
