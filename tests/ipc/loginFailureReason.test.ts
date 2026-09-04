import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { loginFailureReason } from "@src/ipc/handlers/loginFailureReason"

/**
 * The mapping the LOGIN handler logs instead of the caught error's message
 * (issue #352). Two properties matter here, and they pull against each other:
 * the answer has to stay useful enough to debug a field report from, and it
 * has to be impossible for any part of the thrown message to ride out in it.
 *
 * Every password below is a placeholder that exists only to be asserted
 * absent.
 */
describe("loginFailureReason names what went wrong", () => {
  for (const [message, expected] of [
    ["Network request timed out", "timeout"],
    ["Network response is too large", "response-too-large"],
    ["Network response was aborted", "response-aborted"],
    ["Secure account storage is unavailable", "secure-storage-unavailable"],
    ["A system password store is required for account storage", "no-system-password-store"]
  ] as const) {
    it(`reads "${message}" as ${expected}`, () => {
      assert.equal(loginFailureReason(new Error(message)), expected)
    })
  }

  it("carries the HTTP status through, so a 503 outage is not read as a wrong password", () => {
    assert.equal(loginFailureReason(new Error("Network request failed with status 503")), "http-status-503")
    assert.equal(loginFailureReason(new Error("Network request failed with status 401")), "http-status-401")
    assert.equal(loginFailureReason(new Error("Network request failed with status unknown")), "http-status-unknown")
  })

  it("names the system error code when the socket is what failed", () => {
    assert.equal(loginFailureReason(Object.assign(new Error("getaddrinfo ENOTFOUND auth3.vintagestory.at"), { code: "ENOTFOUND" })), "network-ENOTFOUND")
    assert.equal(loginFailureReason(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), "network-ECONNRESET")
    assert.equal(loginFailureReason(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" })), "network-CERT_HAS_EXPIRED")
  })

  it("falls back to the class name when nothing recognises the message", () => {
    assert.equal(loginFailureReason(new Error("something nobody has seen before")), "unclassified-Error")
    assert.equal(loginFailureReason(new TypeError("x is not a function")), "unclassified-TypeError")
  })

  it("says so when what was thrown is not an Error at all", () => {
    for (const thrown of ["a bare string", 42, null, undefined, { message: "an object" }]) assert.equal(loginFailureReason(thrown), "non-error-throw")
  })
})

describe("loginFailureReason cannot carry a secret out", () => {
  const PASSWORD = "placeholder-Correct-Horse-9"

  it("drops the message entirely, including one that spliced the password into prose", () => {
    // The shape `redactSensitiveText` does not catch, and the reason this
    // function exists: a bare value in a sentence, with no `password:` or
    // `password=` marker in front of it for the pattern to key off.
    const reason = loginFailureReason(new Error(`upstream rejected body email=a@b.invalid ${PASSWORD} totp 123456`))

    assert.equal(reason.includes(PASSWORD), false)
    assert.equal(reason.includes("123456"), false)
    assert.equal(reason, "unclassified-Error")
  })

  it("refuses a code that is not shaped like one of Node's", () => {
    // `code` is writable, so an error from anywhere could put a whole request
    // body in it. Only an identifier-shaped value is a Node enum member.
    assert.equal(loginFailureReason(Object.assign(new Error("boom"), { code: `posting ${PASSWORD}` })), "unclassified-Error")
    assert.equal(loginFailureReason(Object.assign(new Error("boom"), { code: PASSWORD })), "unclassified-Error")
    assert.equal(loginFailureReason(Object.assign(new Error("boom"), { code: 42 })), "unclassified-Error")
    assert.equal(loginFailureReason(Object.assign(new Error("boom"), { code: "E".repeat(64) })), "unclassified-Error")
  })

  it("refuses a name that is not shaped like a class name", () => {
    // Same argument as `code`: `name` is writable too, so it gets the same guard.
    const named = new Error("boom")
    named.name = `Error: while sending ${PASSWORD}`

    assert.equal(loginFailureReason(named), "unclassified")

    const empty = new Error("boom")
    empty.name = ""
    assert.equal(loginFailureReason(empty), "unclassified")
  })

  it("keeps only the digits out of a status message, never the rest of it", () => {
    const reason = loginFailureReason(new Error(`Network request failed with status 500 for body ${PASSWORD}`))

    assert.equal(reason.includes(PASSWORD), false)
    // Anchored, so a message that merely starts like the known one is not
    // matched and sliced: it falls through to the class name instead.
    assert.equal(reason, "unclassified-Error")
  })
})
