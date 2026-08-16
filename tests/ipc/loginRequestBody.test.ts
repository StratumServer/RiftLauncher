import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { buildLoginRequestBody, GAME_LOGIN_VERSION } from "../../src/ipc/handlers/loginRequestBody"

describe("buildLoginRequestBody", () => {
  it("carries the five fields the game client sends, in the game client's order", () => {
    const body = buildLoginRequestBody("player@example.test", "hunter2", "123456", "fake-prelogin-token")

    assert.deepEqual([...body.keys()], ["email", "password", "totpcode", "prelogintoken", "gameloginversion"])
    assert.equal(body.get("email"), "player@example.test")
    assert.equal(body.get("password"), "hunter2")
    assert.equal(body.get("totpcode"), "123456")
    assert.equal(body.get("prelogintoken"), "fake-prelogin-token")
    assert.equal(body.get("gameloginversion"), GAME_LOGIN_VERSION)
  })

  it("sends totpcode and prelogintoken empty rather than omitting them on a first pass with neither", () => {
    const body = buildLoginRequestBody("player@example.test", "hunter2")

    assert.deepEqual([...body.keys()], ["email", "password", "totpcode", "prelogintoken", "gameloginversion"])
    assert.equal(body.get("totpcode"), "")
    assert.equal(body.get("prelogintoken"), "")
  })

  it("always sends gameloginversion, matching the game client's own contract", () => {
    const body = buildLoginRequestBody("player@example.test", "hunter2")

    assert.equal(body.has("gameloginversion"), true)
    assert.equal(GAME_LOGIN_VERSION.length > 0, true)
  })
})
