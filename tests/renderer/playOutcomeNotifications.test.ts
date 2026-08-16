import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { pickPlayOutcomeNotification } from "../../src/renderer/src/utils/playOutcomeNotifications"

describe("pickPlayOutcomeNotification on a successful exit", () => {
  it("shows nothing when the game exited with code 0", () => {
    assert.equal(pickPlayOutcomeNotification({ ok: true, exitCode: 0 }), null)
  })

  it("shows nothing when the game exited with no code at all", () => {
    assert.equal(pickPlayOutcomeNotification({ ok: true, exitCode: null }), null)
  })

  it("warns when the game exited with a non-zero code", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: true, exitCode: 1 }), { key: "notifications.body.gameExitedWithErrors" })
  })
})

describe("pickPlayOutcomeNotification on a refusal", () => {
  it("keys unsupported-platform to its own sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "unsupported-platform" }), { key: "notifications.body.gameLaunchUnsupportedPlatform" })
  })

  it("keys no-executable to its own sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "no-executable" }), { key: "notifications.body.gameLaunchNoExecutable" })
  })

  it("keys session-write-failed to its own sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "session-write-failed" }), { key: "notifications.body.gameLaunchSessionWriteFailed" })
  })

  it("keys invalid-request to its own sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "invalid-request" }), { key: "notifications.body.gameLaunchInvalidEnvironment" })
  })

  it("keys launch-failed to the generic executing-game sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "launch-failed" }), { key: "notifications.body.errorExecutingGame" })
  })
})
