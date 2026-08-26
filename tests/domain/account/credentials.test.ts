import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { parseLegacyAccount, parseLoginAccount, parseStoredSecrets, parseStoredSecretsById, toPublicAccount } from "../../../src/domain/account/credentials"

const EMAIL = "player@example.test"

describe("parseLoginAccount", () => {
  it("reads the three shapes the game server flag arrives in", () => {
    const base = { playername: "Player", uid: "uid-1", entitlements: "game", sessionkey: "fake-key", sessionsignature: "fake-signature" }

    for (const [raw, expected] of [
      [true, true],
      [1, true],
      ["1", true],
      [false, false],
      [0, false],
      ["0", false]
    ] as const) {
      assert.equal(parseLoginAccount(EMAIL, { ...base, hasgameserver: raw }).publicAccount.hostGameServer, expected, String(raw))
    }
  })

  it("refuses a game server flag it does not recognise instead of coercing it", () => {
    const base = { playername: "Player", uid: "uid-1", entitlements: "game", sessionkey: "fake-key", sessionsignature: "fake-signature" }

    assert.throws(() => parseLoginAccount(EMAIL, { ...base, hasgameserver: "yes" }), /Invalid account game server flag/)
    assert.throws(() => parseLoginAccount(EMAIL, { ...base, hasgameserver: null }), /Invalid account game server flag/)
  })

  it("treats an absent multiplayer token as absent rather than empty", () => {
    const base = { playername: "Player", uid: "uid-1", entitlements: "game", hasgameserver: false, sessionkey: "fake-key", sessionsignature: "fake-signature" }

    assert.equal(parseLoginAccount(EMAIL, { ...base, mptoken: null }).secrets.mptoken, null)
    assert.equal(parseLoginAccount(EMAIL, { ...base, mptoken: "" }).secrets.mptoken, null)
    assert.equal(parseLoginAccount(EMAIL, base).secrets.mptoken, null)
    assert.equal(parseLoginAccount(EMAIL, { ...base, mptoken: "fake-mptoken" }).secrets.mptoken, "fake-mptoken")
  })

  it("reads null, absent, and empty entitlements as no entitlements, and a real value as itself", () => {
    // Issue #74: a real successful login for an account with no entitlements
    // answers `entitlements: null`. Refusing that turned a login the server
    // accepted into a false "wrong credentials" diagnosis.
    const base = { playername: "Player", uid: "uid-1", hasgameserver: false, sessionkey: "fake-key", sessionsignature: "fake-signature" }

    assert.equal(parseLoginAccount(EMAIL, { ...base, entitlements: null }).publicAccount.playerEntitlements, null)
    assert.equal(parseLoginAccount(EMAIL, { ...base, entitlements: "" }).publicAccount.playerEntitlements, null)
    assert.equal(parseLoginAccount(EMAIL, base).publicAccount.playerEntitlements, null)
    assert.equal(parseLoginAccount(EMAIL, { ...base, entitlements: "singleplayer,multiplayer" }).publicAccount.playerEntitlements, "singleplayer,multiplayer")
  })

  it("parses the real successful response shape for an account with no entitlements", () => {
    // Redacted but shape-accurate: the exact body proven against the live
    // auth service in issue #74, secrets replaced by placeholder characters
    // of the same length (44 for the session key, 344 for the signature).
    const REAL_SHAPE_RESPONSE = {
      sessionkey: "k".repeat(44),
      sessionsignature: "s".repeat(344),
      mptoken: null,
      uid: "uid-abcdefghijklmnop",
      entitlements: null,
      playername: "Player",
      hasgameserver: false,
      valid: 1
    }

    const credentials = parseLoginAccount(EMAIL, REAL_SHAPE_RESPONSE)

    assert.deepEqual(credentials.publicAccount, {
      email: EMAIL,
      playerName: "Player",
      playerUid: "uid-abcdefghijklmnop",
      playerEntitlements: null,
      hostGameServer: false
    })
    assert.equal(credentials.secrets.mptoken, null)
    assert.equal(credentials.secrets.sessionKey, REAL_SHAPE_RESPONSE.sessionkey)
  })

  it("refuses anything that is not a response object", () => {
    for (const value of [null, "text", 7, [1, 2, 3], undefined]) {
      assert.throws(() => parseLoginAccount(EMAIL, value), /Invalid login response/, String(value))
    }
  })

  it("names the field it refused without ever quoting its value", () => {
    assert.throws(
      () => parseLoginAccount(EMAIL, { playername: "Player" }),
      (error: Error) => error.message === "Invalid account player uid"
    )
    assert.throws(
      () => parseLoginAccount("", { playername: "Player" }),
      (error: Error) => error.message === "Invalid account email"
    )
  })
})

describe("parseLegacyAccount", () => {
  it("returns null on anything it cannot migrate, so a bad entry never blocks startup", () => {
    assert.equal(parseLegacyAccount(null), null)
    assert.equal(parseLegacyAccount([1, 2]), null)
    assert.equal(parseLegacyAccount({}), null)
    assert.equal(parseLegacyAccount({ email: EMAIL, playerName: "Player" }), null)
  })
})

describe("parseStoredSecrets", () => {
  it("reads the secrets back out of the store", () => {
    assert.deepEqual(parseStoredSecrets({ sessionKey: "fake-key", sessionSignature: "fake-signature", mptoken: "fake-mptoken" }), {
      sessionKey: "fake-key",
      sessionSignature: "fake-signature",
      mptoken: "fake-mptoken"
    })
  })

  it("returns null on an unreadable store, which logs the user out instead of failing the launch", () => {
    assert.equal(parseStoredSecrets(null), null)
    assert.equal(parseStoredSecrets("ciphertext"), null)
    assert.equal(parseStoredSecrets({ sessionKey: "fake-key" }), null)
    assert.equal(parseStoredSecrets({ sessionKey: "", sessionSignature: "fake-signature" }), null)
  })
})

describe("parseStoredSecretsById", () => {
  const SECRETS_A = { sessionKey: "fake-key-a", sessionSignature: "fake-signature-a", mptoken: "fake-mptoken-a" }
  const SECRETS_B = { sessionKey: "fake-key-b", sessionSignature: "fake-signature-b", mptoken: null }

  it("reads every account keyed by its own id", () => {
    const result = parseStoredSecretsById({
      accounts: [
        { id: "uid-a", secrets: SECRETS_A },
        { id: "uid-b", secrets: SECRETS_B }
      ]
    })

    assert.deepEqual(result.get("uid-a"), SECRETS_A)
    assert.deepEqual(result.get("uid-b"), SECRETS_B)
    assert.equal(result.size, 2)
  })

  it("returns an empty map for anything that is not the multi-account shape", () => {
    for (const value of [null, "ciphertext", 7, [1, 2], {}, { accounts: "not an array" }, { accounts: null }]) {
      assert.equal(parseStoredSecretsById(value).size, 0, String(value))
    }
  })

  it("drops one unreadable entry without losing the others", () => {
    const result = parseStoredSecretsById({
      accounts: ["not a record", null, { id: "no-secrets" }, { id: "", secrets: SECRETS_A }, { id: "unreadable-secrets", secrets: { sessionKey: "only-a-key" } }, { id: "uid-b", secrets: SECRETS_B }]
    })

    assert.deepEqual(result, new Map([["uid-b", SECRETS_B]]))
  })

  it("keeps the first entry on a duplicate id", () => {
    const result = parseStoredSecretsById({
      accounts: [
        { id: "uid-a", secrets: SECRETS_A },
        { id: "uid-a", secrets: SECRETS_B }
      ]
    })

    assert.deepEqual(result.get("uid-a"), SECRETS_A)
    assert.equal(result.size, 1)
  })

  it("refuses an id past the maximum account field length", () => {
    const result = parseStoredSecretsById({ accounts: [{ id: "u".repeat(300), secrets: SECRETS_A }] })
    assert.equal(result.size, 0)
  })
})

describe("toPublicAccount", () => {
  it("drops every field that is not part of the renderer-visible half", () => {
    const account = toPublicAccount({
      email: EMAIL,
      playerName: "Player",
      playerUid: "uid-1",
      playerEntitlements: "game",
      hostGameServer: true,
      sessionKey: "fake-key",
      sessionSignature: "fake-signature",
      mptoken: "fake-mptoken"
    })

    assert.deepEqual(account, { email: EMAIL, playerName: "Player", playerUid: "uid-1", playerEntitlements: "game", hostGameServer: true })
    assert.equal(JSON.stringify(account).includes("fake-"), false)
  })

  it("keeps a stored account with no entitlements readable, rather than refusing it", () => {
    const account = toPublicAccount({ email: EMAIL, playerName: "Player", playerUid: "uid-1", playerEntitlements: null, hostGameServer: true })

    assert.deepEqual(account, { email: EMAIL, playerName: "Player", playerUid: "uid-1", playerEntitlements: null, hostGameServer: true })
  })

  it("returns null when the stored account is not usable", () => {
    assert.equal(toPublicAccount(null), null)
    assert.equal(toPublicAccount({ email: EMAIL }), null)
    assert.equal(toPublicAccount({ email: EMAIL, playerName: "Player", playerUid: "uid-1", playerEntitlements: "game", hostGameServer: "yes" }), null)
  })
})
