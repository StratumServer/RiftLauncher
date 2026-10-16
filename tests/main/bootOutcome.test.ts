import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it, vi } from "vitest"

import { logUserDataSetupUnlessBootFailed, reportBootFailure, reportFailedImportUnlessBootFailed } from "@src/main/bootOutcome"

describe("main process boot outcome", () => {
  it("does not write the normal setup log when boot failed", () => {
    const writeLog = vi.fn()

    logUserDataSetupUnlessBootFailed({ detail: "profile unavailable" }, "profile setup", writeLog)

    assert.equal(writeLog.mock.calls.length, 0)
  })

  it("writes the setup log when the profile is ready", () => {
    const writeLog = vi.fn()

    logUserDataSetupUnlessBootFailed(null, "profile setup", writeLog)

    assert.deepEqual(writeLog.mock.calls, [["profile setup"]])
  })

  it("tells the player about a failed import only when the next start will try it again", () => {
    const report = vi.fn()

    reportFailedImportUnlessBootFailed(null, { outcome: "migration-failed", importPending: true }, report)
    assert.equal(report.mock.calls.length, 1)

    reportFailedImportUnlessBootFailed(null, { outcome: "migration-failed", importPending: false }, report)
    reportFailedImportUnlessBootFailed(null, { outcome: "migration-failed" }, report)
    reportFailedImportUnlessBootFailed(null, { outcome: "migrate", importPending: true }, report)
    reportFailedImportUnlessBootFailed({ detail: "profile unavailable" }, { outcome: "migration-failed", importPending: true }, report)
    assert.equal(report.mock.calls.length, 1)
  })

  // src/main/index.ts cannot be imported in a test (it starts Electron), so, as in security-boundaries.test.ts, the source is read.
  it("has the entry point queue the failed-import notice from the boot helper", () => {
    const entry = readFileSync(resolve(__dirname, "../../src/main/index.ts"), "utf8")

    assert.match(entry, /^reportFailedImportUnlessBootFailed\(bootFailure, userDataSetup, noteUserDataImportFailed\)$/m)
  })

  it("prints the full failure before showing it and exiting", () => {
    const calls: string[] = []
    const reported: string[] = []

    const handled = reportBootFailure(
      { detail: "Could not create C:\\Users\\Player\\RiftLauncher.singleton (EACCES)" },
      {
        writeStderr: (message) => {
          calls.push("stderr")
          reported.push(message)
        },
        showErrorBox: (title, message) => {
          calls.push("dialog")
          reported.push(title, message)
        },
        exit: (code) => {
          calls.push("exit")
          reported.push(String(code))
        }
      }
    )

    assert.equal(handled, true)
    assert.deepEqual(calls, ["stderr", "dialog", "exit"])
    assert.deepEqual(reported, [
      "RiftLauncher could not start: Could not create C:\\Users\\Player\\RiftLauncher.singleton (EACCES)\n",
      "RiftLauncher could not start",
      "Could not create C:\\Users\\Player\\RiftLauncher.singleton (EACCES)",
      "1"
    ])
  })

  it("does not report anything when boot succeeded", () => {
    const writeStderr = vi.fn()
    const showErrorBox = vi.fn()
    const exit = vi.fn()

    assert.equal(reportBootFailure(null, { writeStderr, showErrorBox, exit }), false)
    assert.equal(writeStderr.mock.calls.length, 0)
    assert.equal(showErrorBox.mock.calls.length, 0)
    assert.equal(exit.mock.calls.length, 0)
  })
})
