import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { badCredentialsResult, needsTwoFactorResult, sessionStoreUnreadableResult, twoFactorRejectedResult, unexpectedResponseOutcome } from "../../src/ipc/handlers/accountLoginOutcome"

describe("badCredentialsResult / needsTwoFactorResult / twoFactorRejectedResult / sessionStoreUnreadableResult", () => {
  it("carry the domain verdict onto the wire unchanged", () => {
    assert.deepEqual(badCredentialsResult(), { status: "invalid-credentials" })
    assert.deepEqual(needsTwoFactorResult(), { status: "requires-two-factor" })
    assert.deepEqual(twoFactorRejectedResult(), { status: "wrong-two-factor" })
    assert.deepEqual(sessionStoreUnreadableResult(), { status: "session-store-unreadable" })
  })
})

describe("unexpectedResponseOutcome", () => {
  it("resolves unexpected-response, not invalid-credentials", () => {
    const outcome = unexpectedResponseOutcome({ status: "unreadable-response" })

    assert.deepEqual(outcome.result, { status: "unexpected-response" })
  })

  it("carries the diagnosis into the log message when the verdict has one", () => {
    const outcome = unexpectedResponseOutcome({ status: "unreadable-response", diagnosis: 'field "entitlements": expected non-empty string, got empty string' })

    assert.match(outcome.logMessage, /field "entitlements": expected non-empty string, got empty string/)
  })

  it("still names the failure when the verdict carries no diagnosis", () => {
    const outcome = unexpectedResponseOutcome({ status: "unreadable-response" })

    assert.match(outcome.logMessage, /could not be read/)
  })

  it("never lets a value from the body ride along in the log message, only the field name and its type", () => {
    // A diagnosis is built from a field name and a type-level description
    // only; this pins that the outcome mapper does not concatenate anything
    // else in. The canary stands in for what a leaked secret would look like.
    const CANARY = "canary-should-never-appear-in-a-log-line"
    const outcome = unexpectedResponseOutcome({ status: "unreadable-response", diagnosis: 'field "session key": expected non-empty string, got undefined' })

    assert.equal(outcome.logMessage.includes(CANARY), false)
  })
})
