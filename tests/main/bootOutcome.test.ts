import assert from "node:assert/strict"
import { describe, it, vi } from "vitest"

import { logUserDataSetupUnlessBootFailed, reportBootFailure } from "@src/main/bootOutcome"

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
