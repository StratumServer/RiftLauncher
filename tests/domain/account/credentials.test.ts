import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { parseLegacyAccount, parseLoginAccount, parseStoredSecrets, toPublicAccount } from "../../../src/domain/account/credentials"

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

  it("returns null when the stored account is not usable", () => {
    assert.equal(toPublicAccount(null), null)
    assert.equal(toPublicAccount({ email: EMAIL }), null)
    assert.equal(toPublicAccount({ email: EMAIL, playerName: "Player", playerUid: "uid-1", playerEntitlements: "game", hostGameServer: "yes" }), null)
  })
})
