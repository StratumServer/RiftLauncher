import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { interpretFirstPass, interpretSecondPass } from "../../../src/domain/account/login"

const EMAIL = "player@example.test"

/**
 * A response the service considers valid. Every value is an obvious fake: the
 * point of these tests is the interpretation, and a fixture that looked like a
 * real session key would be one copy of a secret too many.
 */
function successBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    valid: 1,
    reason: null,
    prelogintoken: null,
    playername: "Player",
    uid: "uid-1",
    entitlements: "game",
    hasgameserver: false,
    sessionkey: "fake-session-key",
    sessionsignature: "fake-session-signature",
    mptoken: "fake-mptoken",
    ...overrides
  })
}

function refusalBody(reason: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ valid: 0, reason, ...overrides })
}

/**
 * The exact body proven against the live auth service in issue #74: a real
 * successful login for an account with no entitlements. Secrets are
 * replaced by placeholder characters of the same length as the real values
 * (44 for the session key, 344 for the signature); every other field,
 * including the `null` entitlements and `false` hasgameserver, is as-observed.
 */
function realShapeResponseWithNoEntitlements(): string {
  return JSON.stringify({
    sessionkey: "k".repeat(44),
    sessionsignature: "s".repeat(344),
    mptoken: null,
    uid: "uid-abcdefghijklmnop",
    entitlements: null,
    playername: "Player",
    hasgameserver: false,
    valid: 1
  })
}

describe("interpretFirstPass", () => {
  it("establishes the session when the account has no two-factor", () => {
    const verdict = interpretFirstPass(EMAIL, successBody(), { twoFactorCodeProvided: false })

    assert.equal(verdict.status, "success")
    if (verdict.status !== "success") throw new Error("unreachable")

    assert.deepEqual(verdict.credentials.publicAccount, {
      email: EMAIL,
      playerName: "Player",
      playerUid: "uid-1",
      playerEntitlements: "game",
      hostGameServer: false
    })
    assert.equal(verdict.credentials.secrets.sessionKey, "fake-session-key")
  })

  it("establishes the session for the real response shape proven in issue #74 (no entitlements)", () => {
    const verdict = interpretFirstPass(EMAIL, realShapeResponseWithNoEntitlements(), { twoFactorCodeProvided: false })

    assert.equal(verdict.status, "success")
    if (verdict.status !== "success") throw new Error("unreachable")

    assert.deepEqual(verdict.credentials.publicAccount, {
      email: EMAIL,
      playerName: "Player",
      playerUid: "uid-abcdefghijklmnop",
      playerEntitlements: null,
      hostGameServer: false
    })
    assert.equal(verdict.credentials.secrets.mptoken, null)
  })

  it("asks the user for a code when the account has two-factor and none was typed", () => {
    const verdict = interpretFirstPass(EMAIL, refusalBody("requiretotpcode", { prelogintoken: "fake-prelogin-token" }), { twoFactorCodeProvided: false })

    assert.deepEqual(verdict, { status: "needs-two-factor" })
  })

  it("carries the pre-login token forward when a code was typed", () => {
    const verdict = interpretFirstPass(EMAIL, refusalBody("requiretotpcode", { prelogintoken: "fake-prelogin-token" }), { twoFactorCodeProvided: true })

    assert.deepEqual(verdict, { status: "complete-two-factor", preLoginToken: "fake-prelogin-token" })
  })

  it("still owes a second pass when the service omits the pre-login token, which it does", () => {
    const verdict = interpretFirstPass(EMAIL, refusalBody("requiretotpcode"), { twoFactorCodeProvided: true })

    assert.deepEqual(verdict, { status: "complete-two-factor", preLoginToken: undefined })
  })

  it("reads a refused login as bad credentials", () => {
    assert.deepEqual(interpretFirstPass(EMAIL, refusalBody("invalidemailorpassword"), { twoFactorCodeProvided: false }), { status: "bad-credentials", serverReason: "invalidemailorpassword" })
  })

  it("collapses every refusal it does not name into bad credentials, lockouts included", () => {
    for (const reason of ["accountlocked", "toomanyattempts", "", null, 7]) {
      // serverReason carries the service's own string verbatim so the host can
      // log which refusal was collapsed; a non-string reason normalizes to "".
      const expectedReason = typeof reason === "string" ? reason : ""
      assert.deepEqual(interpretFirstPass(EMAIL, refusalBody(reason), { twoFactorCodeProvided: true }), { status: "bad-credentials", serverReason: expectedReason }, `reason ${String(reason)}`)
    }
  })

  it("reads the three ways the service spells a refusal, and only those", () => {
    for (const valid of [0, "0", false]) {
      assert.deepEqual(
        interpretFirstPass(EMAIL, JSON.stringify({ valid, reason: "invalidemailorpassword" }), { twoFactorCodeProvided: false }),
        { status: "bad-credentials", serverReason: "invalidemailorpassword" },
        `valid ${String(valid)}`
      )
    }

    // A body with no `valid` field is not a refusal: it is a success claim that
    // then has to hold up, which is what the launcher has always assumed.
    const verdict = interpretFirstPass(EMAIL, successBody({ valid: undefined }), { twoFactorCodeProvided: false })
    assert.equal(verdict.status, "success")
  })
})

describe("interpretSecondPass", () => {
  it("establishes the session once the code is accepted", () => {
    const verdict = interpretSecondPass(EMAIL, successBody())

    assert.equal(verdict.status, "success")
  })

  it("names a rejected code", () => {
    assert.deepEqual(interpretSecondPass(EMAIL, refusalBody("wrongtotpcode")), { status: "two-factor-rejected" })
  })

  it("does not ask for a third request when the service repeats requiretotpcode", () => {
    const verdict = interpretSecondPass(EMAIL, refusalBody("requiretotpcode", { prelogintoken: "fake-prelogin-token" }))

    assert.deepEqual(verdict, { status: "bad-credentials", serverReason: "requiretotpcode" })
  })

  it("reads any other refusal as bad credentials", () => {
    assert.deepEqual(interpretSecondPass(EMAIL, refusalBody("invalidemailorpassword")), { status: "bad-credentials", serverReason: "invalidemailorpassword" })
  })
})

describe("responses the launcher cannot act on", () => {
  it("names text that never was JSON", () => {
    assert.deepEqual(interpretFirstPass(EMAIL, "<html>502 Bad Gateway</html>", { twoFactorCodeProvided: false }), { status: "unreadable-response" })
    assert.deepEqual(interpretSecondPass(EMAIL, ""), { status: "unreadable-response" })
  })

  it("names JSON that is not an object", () => {
    for (const body of ["[1, 2, 3]", '"nope"', "null", "42"]) {
      assert.deepEqual(interpretFirstPass(EMAIL, body, { twoFactorCodeProvided: false }), { status: "unreadable-response" }, body)
      assert.deepEqual(interpretSecondPass(EMAIL, body), { status: "unreadable-response" }, body)
    }
  })

  it("still refuses null sessionkey, missing uid, and empty playername, unlike the now-nullable entitlements", () => {
    const nullSessionKey = interpretFirstPass(EMAIL, successBody({ sessionkey: null }), { twoFactorCodeProvided: false })
    assert.equal(nullSessionKey.status, "unreadable-response")
    assert.equal((nullSessionKey as { diagnosis?: string }).diagnosis, 'field "session key": expected non-empty string, got null')

    const missingUid = interpretFirstPass(EMAIL, successBody({ uid: undefined }), { twoFactorCodeProvided: false })
    assert.equal(missingUid.status, "unreadable-response")
    assert.equal((missingUid as { diagnosis?: string }).diagnosis, 'field "player uid": expected non-empty string, got undefined')

    const emptyPlayerName = interpretFirstPass(EMAIL, successBody({ playername: "" }), { twoFactorCodeProvided: false })
    assert.equal(emptyPlayerName.status, "unreadable-response")
    assert.equal((emptyPlayerName as { diagnosis?: string }).diagnosis, 'field "player name": expected non-empty string, got empty string')
  })

  it("refuses a valid response with no session key rather than storing an empty session", () => {
    const first = interpretFirstPass(EMAIL, successBody({ sessionkey: "" }), { twoFactorCodeProvided: false })
    assert.equal(first.status, "unreadable-response")
    assert.equal((first as { diagnosis?: string }).diagnosis, 'field "session key": expected non-empty string, got empty string')

    const second = interpretSecondPass(EMAIL, successBody({ sessionsignature: undefined }))
    assert.equal(second.status, "unreadable-response")
    assert.equal((second as { diagnosis?: string }).diagnosis, 'field "session signature": expected non-empty string, got undefined')
  })

  it("refuses a valid response missing the player fields", () => {
    const missingName = interpretFirstPass(EMAIL, successBody({ playername: undefined }), { twoFactorCodeProvided: false })
    assert.equal(missingName.status, "unreadable-response")
    assert.equal((missingName as { diagnosis?: string }).diagnosis, 'field "player name": expected non-empty string, got undefined')

    const badFlag = interpretFirstPass(EMAIL, successBody({ hasgameserver: "maybe" }), { twoFactorCodeProvided: false })
    assert.equal(badFlag.status, "unreadable-response")
    assert.equal((badFlag as { diagnosis?: string }).diagnosis, "field \"game server flag\": expected boolean, 1/0, or '1'/'0', got string")
  })
})

describe("the diagnosis on an unreadable success claim", () => {
  it("names the field that failed, and only that, when a success-claiming body fails to parse", () => {
    const verdict = interpretFirstPass(EMAIL, successBody({ playername: "" }), { twoFactorCodeProvided: false })

    assert.equal(verdict.status, "unreadable-response")
    assert.equal((verdict as { diagnosis?: string }).diagnosis, 'field "player name": expected non-empty string, got empty string')
  })

  it("never lets a value from the body ride along in the diagnosis, canary included", () => {
    // The session key and player name below are canaries: if a future change
    // to `establish`/`parseLoginAccount` ever interpolated a raw field value
    // into the diagnosis instead of a type-level description, one of these
    // exact strings would show up in the assertion below and fail it.
    const CANARY_SESSION_KEY = "canary-session-key-should-never-leak"
    const CANARY_PLAYER_NAME = "canary-player-name-should-never-leak"

    const verdict = interpretFirstPass(EMAIL, successBody({ playername: "", sessionkey: CANARY_SESSION_KEY }), { twoFactorCodeProvided: false })

    assert.equal(verdict.status, "unreadable-response")
    const diagnosis = (verdict as { diagnosis?: string }).diagnosis ?? ""
    assert.ok(diagnosis.length > 0, "expected a diagnosis string")
    assert.equal(diagnosis.includes(CANARY_SESSION_KEY), false)
    assert.equal(diagnosis.includes(CANARY_PLAYER_NAME), false)
    assert.equal(diagnosis, 'field "player name": expected non-empty string, got empty string')
  })

  it("does not refuse a success claim with no entitlements, since a real response sends exactly that", () => {
    // Issue #74. Before this fix, entitlements: null on an otherwise valid
    // success body produced this same "unreadable-response" verdict and told
    // the player their credentials were wrong.
    const verdict = interpretFirstPass(EMAIL, successBody({ entitlements: null }), { twoFactorCodeProvided: false })

    assert.equal(verdict.status, "success")
  })

  it("names a missing field as undefined without ever mentioning the field it was allowed to keep", () => {
    const CANARY_ENTITLEMENTS = "canary-entitlements-value"
    const verdict = interpretSecondPass(EMAIL, successBody({ entitlements: CANARY_ENTITLEMENTS, sessionkey: undefined }))

    assert.equal(verdict.status, "unreadable-response")
    const diagnosis = (verdict as { diagnosis?: string }).diagnosis ?? ""
    assert.equal(diagnosis, 'field "session key": expected non-empty string, got undefined')
    assert.equal(diagnosis.includes(CANARY_ENTITLEMENTS), false)
  })

  it("does not attach a diagnosis when the body was never JSON or never an object, since parseLoginAccount was never reached", () => {
    const notJson = interpretFirstPass(EMAIL, "<html>502 Bad Gateway</html>", { twoFactorCodeProvided: false })
    assert.deepEqual(notJson, { status: "unreadable-response" })

    const notObject = interpretFirstPass(EMAIL, "42", { twoFactorCodeProvided: false })
    assert.deepEqual(notObject, { status: "unreadable-response" })
  })
})

describe("secret hygiene", () => {
  it("keeps session credentials out of every verdict that is not a success", () => {
    const verdicts = [
      interpretFirstPass(EMAIL, refusalBody("invalidemailorpassword"), { twoFactorCodeProvided: false }),
      interpretFirstPass(EMAIL, refusalBody("requiretotpcode"), { twoFactorCodeProvided: false }),
      interpretSecondPass(EMAIL, refusalBody("wrongtotpcode")),
      interpretSecondPass(EMAIL, successBody({ sessionkey: undefined }))
    ]

    for (const verdict of verdicts) {
      assert.equal("credentials" in verdict, false, verdict.status)
      assert.equal(JSON.stringify(verdict).includes("fake-session"), false, verdict.status)
    }
  })

  it("keeps the session out of the public half of a success", () => {
    const verdict = interpretFirstPass(EMAIL, successBody(), { twoFactorCodeProvided: false })
    if (verdict.status !== "success") throw new Error("unreachable")

    assert.equal(JSON.stringify(verdict.credentials.publicAccount).includes("fake-"), false)
  })
})
