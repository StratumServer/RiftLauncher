import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  attemptInstallerTreeKill,
  buildInstallerTreeKillCommand,
  extractionOutcomeToResult,
  installerFailedResult,
  installerMissingResult,
  installerOkResult,
  installerTimedOutResult,
  notWindowsResult,
  shouldKillInstallerTree,
  spawnInstallerOutcomeToResult
} from "../../src/ipc/handlers/installerTimeoutOutcome"

describe("buildInstallerTreeKillCommand", () => {
  it("builds a taskkill command that walks and forces the whole process tree", () => {
    assert.deepEqual(buildInstallerTreeKillCommand(4242), { command: "taskkill", args: ["/pid", "4242", "/T", "/F"] })
  })

  it("stringifies the pid rather than leaving it a number", () => {
    const { args } = buildInstallerTreeKillCommand(1)
    assert.equal(typeof args[1], "string")
    assert.equal(args[1], "1")
  })
})

describe("shouldKillInstallerTree", () => {
  it("allows a kill on win32 with a real pid", () => {
    assert.equal(shouldKillInstallerTree("win32", 1234), true)
  })

  it("refuses on any other platform even with a pid", () => {
    assert.equal(shouldKillInstallerTree("linux", 1234), false)
    assert.equal(shouldKillInstallerTree("darwin", 1234), false)
  })

  it("refuses on win32 when spawn() never produced a pid", () => {
    assert.equal(shouldKillInstallerTree("win32", undefined), false)
  })
})

type FakeKillable = { on: (event: "error", listener: (error: unknown) => void) => void }

describe("attemptInstallerTreeKill", () => {
  function fakeLog(): { log: (level: "error" | "debug", message: string) => void; calls: Array<[string, string]> } {
    const calls: Array<[string, string]> = []
    return { log: (level, message) => calls.push([level, message]), calls }
  }

  function noopKillable(): FakeKillable {
    return { on: () => undefined }
  }

  it("does nothing off win32, even with a pid", () => {
    let spawnCalled = false
    const { log, calls } = fakeLog()
    const spawnFn = (): FakeKillable => {
      spawnCalled = true
      return noopKillable()
    }
    attemptInstallerTreeKill(1234, "linux", spawnFn, log)
    assert.equal(spawnCalled, false)
    assert.deepEqual(calls, [])
  })

  it("does nothing on win32 without a pid", () => {
    let spawnCalled = false
    const { log, calls } = fakeLog()
    const spawnFn = (): FakeKillable => {
      spawnCalled = true
      return noopKillable()
    }
    attemptInstallerTreeKill(undefined, "win32", spawnFn, log)
    assert.equal(spawnCalled, false)
    assert.deepEqual(calls, [])
  })

  it("spawns taskkill with the process tree's pid on win32 and logs nothing when it launches fine", () => {
    const seenCalls: Array<{ command: string; args: string[] }> = []
    const { log, calls } = fakeLog()
    const spawnFn = (command: string, args: string[]): FakeKillable => {
      seenCalls.push({ command, args })
      return noopKillable()
    }
    attemptInstallerTreeKill(4242, "win32", spawnFn, log)
    assert.deepEqual(seenCalls, [{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"] }])
    assert.deepEqual(calls, [])
  })

  it("logs when the spawned taskkill process itself errors", () => {
    const { log, calls } = fakeLog()
    let errorListener: ((error: unknown) => void) | undefined
    const spawnFn = (): FakeKillable => ({
      on: (_event, listener): void => {
        errorListener = listener
      }
    })
    attemptInstallerTreeKill(4242, "win32", spawnFn, log)
    errorListener?.(new Error("ENOENT"))
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.[0], "error")
    assert.equal(calls[1]?.[0], "debug")
  })

  it("logs when spawning taskkill throws synchronously", () => {
    const { log, calls } = fakeLog()
    const spawnFn = (): FakeKillable => {
      throw new Error("spawn EPERM")
    }
    attemptInstallerTreeKill(4242, "win32", spawnFn, log)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.[0], "error")
    assert.equal(calls[1]?.[0], "debug")
  })
})

describe("the named RUN_INSTALLER verdicts", () => {
  it("notWindowsResult", () => {
    assert.deepEqual(notWindowsResult(), { ok: false, reason: "not-windows" })
  })

  it("installerMissingResult", () => {
    assert.deepEqual(installerMissingResult(), { ok: false, reason: "installer-missing" })
  })

  it("installerOkResult", () => {
    assert.deepEqual(installerOkResult(), { ok: true })
  })

  it("installerFailedResult", () => {
    assert.deepEqual(installerFailedResult(), { ok: false, reason: "installer-failed" })
  })

  it("installerTimedOutResult", () => {
    assert.deepEqual(installerTimedOutResult(), { ok: false, reason: "installer-timed-out" })
  })
})

describe("extractionOutcomeToResult", () => {
  it("maps a successful extraction to ok", () => {
    assert.deepEqual(extractionOutcomeToResult("extracted"), { ok: true })
  })

  it("maps a failed extraction to installer-failed, not a distinct reason", () => {
    assert.deepEqual(extractionOutcomeToResult("failed"), { ok: false, reason: "installer-failed" })
  })
})

describe("spawnInstallerOutcomeToResult", () => {
  it("maps a clean install to ok", () => {
    assert.deepEqual(spawnInstallerOutcomeToResult("installed"), { ok: true })
  })

  it("maps a timeout to installer-timed-out", () => {
    assert.deepEqual(spawnInstallerOutcomeToResult("timed-out"), { ok: false, reason: "installer-timed-out" })
  })

  it("maps any other failure (launch error, non-zero exit, setup exception) to installer-failed", () => {
    assert.deepEqual(spawnInstallerOutcomeToResult("failed"), { ok: false, reason: "installer-failed" })
  })
})
