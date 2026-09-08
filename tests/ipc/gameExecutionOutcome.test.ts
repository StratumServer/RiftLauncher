import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  appendStderrScan,
  gameProcessOutcomeToResult,
  hasMissingDotnetSentinel,
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

  it("maps the missing-runtime flag to missing-dotnet, whatever the exit code was", () => {
    assert.deepEqual(gameProcessOutcomeToResult({ started: true, exitCode: 150, missingRuntime: true }), { ok: false, reason: "missing-dotnet" })
  })

  it("leaves a non-zero exit without the flag alone: the exit code is still never judged", () => {
    assert.deepEqual(gameProcessOutcomeToResult({ started: true, exitCode: 150, missingRuntime: false }), { ok: true, exitCode: 150 })
  })
})

describe("the missing .NET stderr scan", () => {
  it("finds the host's sentence in one chunk", () => {
    const scan = appendStderrScan("", "You must install or update .NET to run this application.\nFramework: 'Microsoft.NETCore.App', version '10.0.0' (x64)\n")
    assert.equal(hasMissingDotnetSentinel(scan), true)
  })

  it("still finds it when the sentence arrives split across two chunks", () => {
    const first = appendStderrScan("", "You must install or upd")
    const scan = appendStderrScan(first, "ate .NET to run this application.\n")
    assert.equal(hasMissingDotnetSentinel(scan), true)
  })

  it("ignores stderr the game writes for any other reason", () => {
    const scan = appendStderrScan("", "Gtk-Message: Failed to load module\nSystem.Exception: something else went wrong\n")
    assert.equal(hasMissingDotnetSentinel(scan), false)
  })

  it("stops accumulating once the bound is reached, so a chatty game cannot grow the scan", () => {
    const scan = appendStderrScan(appendStderrScan("", "x".repeat(5_000)), "You must install or update .NET to run this application.")
    assert.equal(scan.length, 4_096)
    assert.equal(hasMissingDotnetSentinel(scan), false)
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
