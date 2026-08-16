import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  gameProcessOutcomeToResult,
  invalidExecutableResult,
  invalidRequestResult,
  launchPlanFailureResult,
  noExecutableResult,
  sessionWriteFailedResult
} from "../../src/ipc/handlers/gameExecutionOutcome"

describe("gameProcessOutcomeToResult", () => {
  it("resolves ok with the exit code when the game started and closed cleanly", () => {
    assert.deepEqual(gameProcessOutcomeToResult({ started: true, exitCode: 0 }), { ok: true, exitCode: 0 })
  })

  it("carries a non-zero exit code through untouched, not read as a launch failure", () => {
    assert.deepEqual(gameProcessOutcomeToResult({ started: true, exitCode: 134 }), { ok: true, exitCode: 134 })
  })

  it("carries a null exit code through untouched", () => {
    assert.deepEqual(gameProcessOutcomeToResult({ started: true, exitCode: null }), { ok: true, exitCode: null })
  })

  it("maps a spawn failure to launch-failed instead of rejecting", () => {
    assert.deepEqual(gameProcessOutcomeToResult({ started: false, error: "ENOENT" }), { ok: false, reason: "launch-failed" })
  })

  it("maps a spawn failure with no error message to launch-failed too", () => {
    assert.deepEqual(gameProcessOutcomeToResult({ started: false }), { ok: false, reason: "launch-failed" })
  })
})

describe("launchPlanFailureResult", () => {
  it("carries buildGameLaunchPlan's reason onto the wire unchanged", () => {
    assert.deepEqual(launchPlanFailureResult("unsupported-platform"), { ok: false, reason: "unsupported-platform" })
    assert.deepEqual(launchPlanFailureResult("no-executable"), { ok: false, reason: "no-executable" })
  })
})

describe("the other named refusals", () => {
  it("noExecutableResult", () => {
    assert.deepEqual(noExecutableResult(), { ok: false, reason: "no-executable" })
  })

  it("invalidExecutableResult", () => {
    assert.deepEqual(invalidExecutableResult(), { ok: false, reason: "launch-failed" })
  })

  it("sessionWriteFailedResult", () => {
    assert.deepEqual(sessionWriteFailedResult(), { ok: false, reason: "session-write-failed" })
  })

  it("invalidRequestResult", () => {
    assert.deepEqual(invalidRequestResult(), { ok: false, reason: "invalid-request" })
  })
})
