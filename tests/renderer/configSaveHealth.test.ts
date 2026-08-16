import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  CONFIG_SAVE_FAILURE_STREAK_THRESHOLD,
  configSaveFailureMessageKey,
  initialConfigSaveHealthState,
  updateConfigSaveHealth,
  type ConfigSaveHealthState
} from "../../src/renderer/src/features/config/utils/saveHealth"

const WRITE_FAILED_RESULT: SaveConfigResult = { ok: false, reason: "write-failed" }
const UNAUTHORIZED_RESULT: SaveConfigResult = { ok: false, reason: "unauthorized-path" }
const OK_RESULT: SaveConfigResult = { ok: true }

describe("updateConfigSaveHealth on a transient blip", () => {
  it("stays quiet on a single failure", () => {
    const { state, notice } = updateConfigSaveHealth(initialConfigSaveHealthState, WRITE_FAILED_RESULT)
    assert.equal(notice, null)
    assert.equal(state.failureStreak, 1)
    assert.equal(state.notifiedFailing, false)
  })

  it("stays quiet when a single failure is immediately followed by a success", () => {
    const afterFailure = updateConfigSaveHealth(initialConfigSaveHealthState, WRITE_FAILED_RESULT)
    const afterRecovery = updateConfigSaveHealth(afterFailure.state, OK_RESULT)

    assert.equal(afterRecovery.notice, null, "a blip that never crossed the threshold has nothing to recover from")
    assert.deepEqual(afterRecovery.state, initialConfigSaveHealthState)
  })
})

describe("updateConfigSaveHealth on a real streak", () => {
  it("notifies exactly once, the moment the streak crosses the threshold", () => {
    let state: ConfigSaveHealthState = initialConfigSaveHealthState
    const notices: unknown[] = []

    for (let i = 0; i < CONFIG_SAVE_FAILURE_STREAK_THRESHOLD + 3; i++) {
      const decision = updateConfigSaveHealth(state, WRITE_FAILED_RESULT)
      state = decision.state
      notices.push(decision.notice)
    }

    const failingNotices = notices.filter((n) => n !== null)
    assert.equal(failingNotices.length, 1, `expected exactly one notice across the streak, got ${JSON.stringify(notices)}`)
    assert.deepEqual(failingNotices[0], { kind: "failing", reason: "write-failed" })
    assert.equal(state.notifiedFailing, true)
  })

  it("reports recovery once, after a notified streak is followed by a success", () => {
    let state: ConfigSaveHealthState = initialConfigSaveHealthState
    for (let i = 0; i < CONFIG_SAVE_FAILURE_STREAK_THRESHOLD; i++) {
      state = updateConfigSaveHealth(state, WRITE_FAILED_RESULT).state
    }
    assert.equal(state.notifiedFailing, true, "sanity check: the streak should have notified by now")

    const recovery = updateConfigSaveHealth(state, OK_RESULT)
    assert.deepEqual(recovery.notice, { kind: "recovered" })
    assert.deepEqual(recovery.state, initialConfigSaveHealthState)

    const nextRecovery = updateConfigSaveHealth(recovery.state, OK_RESULT)
    assert.equal(nextRecovery.notice, null, "recovery is reported once, not on every subsequent success")
  })

  it("does not re-notify on later failures within the same streak", () => {
    let state: ConfigSaveHealthState = initialConfigSaveHealthState
    for (let i = 0; i < CONFIG_SAVE_FAILURE_STREAK_THRESHOLD; i++) {
      state = updateConfigSaveHealth(state, WRITE_FAILED_RESULT).state
    }

    const anotherFailure = updateConfigSaveHealth(state, WRITE_FAILED_RESULT)
    assert.equal(anotherFailure.notice, null)
    assert.equal(anotherFailure.state.failureStreak, CONFIG_SAVE_FAILURE_STREAK_THRESHOLD + 1)
  })

  it("names the failing notice with whichever reason crossed the threshold, even if the streak changed reasons", () => {
    const afterFirst = updateConfigSaveHealth(initialConfigSaveHealthState, UNAUTHORIZED_RESULT)
    const afterSecond = updateConfigSaveHealth(afterFirst.state, WRITE_FAILED_RESULT)

    assert.deepEqual(afterSecond.notice, { kind: "failing", reason: "write-failed" })
  })
})

describe("configSaveFailureMessageKey", () => {
  it("keys invalid-payload to its own sentence", () => {
    assert.equal(configSaveFailureMessageKey("invalid-payload"), "notifications.body.configSaveInvalidPayload")
  })

  it("keys unauthorized-path to its own sentence", () => {
    assert.equal(configSaveFailureMessageKey("unauthorized-path"), "notifications.body.configSaveUnauthorizedPath")
  })

  it("keys write-failed to its own sentence", () => {
    assert.equal(configSaveFailureMessageKey("write-failed"), "notifications.body.configSaveWriteFailed")
  })
})
