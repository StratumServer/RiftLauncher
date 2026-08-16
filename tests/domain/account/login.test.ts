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
    assert.deepEqual(interpretFirstPass(EMAIL, refusalBody("invalidemailorpassword"), { twoFactorCodeProvided: false }), { status: "bad-credentials" })
  })

  it("collapses every refusal it does not name into bad credentials, lockouts included", () => {
    for (const reason of ["accountlocked", "toomanyattempts", "", null, 7]) {
      assert.deepEqual(interpretFirstPass(EMAIL, refusalBody(reason), { twoFactorCodeProvided: true }), { status: "bad-credentials" }, `reason ${String(reason)}`)
    }
  })

  it("reads the three ways the service spells a refusal, and only those", () => {
    for (const valid of [0, "0", false]) {
      assert.deepEqual(
        interpretFirstPass(EMAIL, JSON.stringify({ valid, reason: "invalidemailorpassword" }), { twoFactorCodeProvided: false }),
        { status: "bad-credentials" },
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

    assert.deepEqual(verdict, { status: "bad-credentials" })
  })

  it("reads any other refusal as bad credentials", () => {
    assert.deepEqual(interpretSecondPass(EMAIL, refusalBody("invalidemailorpassword")), { status: "bad-credentials" })
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

  it("refuses a valid response with no session key rather than storing an empty session", () => {
    assert.deepEqual(interpretFirstPass(EMAIL, successBody({ sessionkey: "" }), { twoFactorCodeProvided: false }), { status: "unreadable-response" })
    assert.deepEqual(interpretSecondPass(EMAIL, successBody({ sessionsignature: undefined })), { status: "unreadable-response" })
  })

  it("refuses a valid response missing the player fields", () => {
    assert.deepEqual(interpretFirstPass(EMAIL, successBody({ playername: undefined }), { twoFactorCodeProvided: false }), { status: "unreadable-response" })
    assert.deepEqual(interpretFirstPass(EMAIL, successBody({ hasgameserver: "maybe" }), { twoFactorCodeProvided: false }), { status: "unreadable-response" })
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
