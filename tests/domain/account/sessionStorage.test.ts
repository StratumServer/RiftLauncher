import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { basicPasswordStoreSwitch, DEFAULT_ALLOW_BASIC_SESSION_STORE } from "@domain/account/sessionStorage"

/**
 * The decision src/main/index.ts makes before Electron starts: whether to ask Chromium for the
 * basic password store. It is pure so it can be pinned here rather than in a process that has to
 * boot Electron to answer.
 *
 * The switch weakens where a session is kept, so what matters most is everything that must NOT
 * produce it: an unanswered config, a platform that has a keychain of its own, and the shipped
 * default.
 */
describe("basicPasswordStoreSwitch", () => {
  it("asks for the basic store on Linux when the player turned the setting on", () => {
    assert.equal(basicPasswordStoreSwitch("linux", true), "basic")
  })

  it("asks for nothing on Linux while the setting is off", () => {
    assert.equal(basicPasswordStoreSwitch("linux", false), null)
  })

  for (const platform of ["win32", "darwin", "freebsd", ""] as const) {
    it(`asks for nothing on ${platform || "an unnamed platform"}, setting or no setting`, () => {
      // Windows and macOS have a keychain that is always there: asking them for the basic store
      // would give up real protection and buy nothing back.
      assert.equal(basicPasswordStoreSwitch(platform, true), null)
      assert.equal(basicPasswordStoreSwitch(platform, false), null)
    })
  }

  it("asks for nothing under the shipped default", () => {
    assert.equal(DEFAULT_ALLOW_BASIC_SESSION_STORE, false)
    assert.equal(basicPasswordStoreSwitch("linux", DEFAULT_ALLOW_BASIC_SESSION_STORE), null)
  })
})
