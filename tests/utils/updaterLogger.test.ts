import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { createUpdaterLogger } from "../../src/utils/updaterLogger"

/** Everything the fake log function recorded, in call order. */
function recordingLog(): { calls: Array<{ mode: ErrorTypes; message: string }>; log: (mode: ErrorTypes, message: string) => void } {
  const calls: Array<{ mode: ErrorTypes; message: string }> = []
  return {
    calls,
    log: (mode: ErrorTypes, message: string): void => {
      calls.push({ mode, message })
    }
  }
}

describe("createUpdaterLogger level mapping", () => {
  it("routes info to the info mode", () => {
    const { calls, log } = recordingLog()
    createUpdaterLogger(log).info("checking for update")

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.mode, "info")
  })

  it("routes warn to the warn mode", () => {
    const { calls, log } = recordingLog()
    createUpdaterLogger(log).warn("cannot find latest.yml")

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.mode, "warn")
  })

  it("routes error to the error mode", () => {
    const { calls, log } = recordingLog()
    createUpdaterLogger(log).error("update check failed")

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.mode, "error")
  })

  it("routes debug to the debug mode", () => {
    const { calls, log } = recordingLog()
    createUpdaterLogger(log).debug?.("full update config")

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.mode, "debug")
  })
})

describe("createUpdaterLogger message content", () => {
  it("includes the message text and a source prefix", () => {
    const { calls, log } = recordingLog()
    createUpdaterLogger(log).info("checking for update")

    assert.match(calls[0]?.message ?? "", /\[utils\/updaterLogger\.ts\]/)
    assert.match(calls[0]?.message ?? "", /\[autoUpdater\]/)
    assert.match(calls[0]?.message ?? "", /checking for update$/)
  })

  it("stringifies a non-string value instead of dropping it", () => {
    const { calls, log } = recordingLog()
    const cause = new Error("feed unreachable")
    createUpdaterLogger(log).error(cause)

    assert.match(calls[0]?.message ?? "", /Error: feed unreachable/)
  })

  it("stringifies a missing argument rather than producing an empty line", () => {
    const { calls, log } = recordingLog()
    createUpdaterLogger(log).info()

    assert.match(calls[0]?.message ?? "", /undefined$/)
  })
})

describe("createUpdaterLogger default log function", () => {
  it("returns an object usable without passing a log function", () => {
    const logger = createUpdaterLogger()

    assert.equal(typeof logger.info, "function")
    assert.equal(typeof logger.warn, "function")
    assert.equal(typeof logger.error, "function")
    assert.equal(typeof logger.debug, "function")
  })
})
