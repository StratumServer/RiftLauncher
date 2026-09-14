import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  AccountStorageFailure,
  ERROR_NAMES,
  HTTP_STATUSES,
  loginFailureFamily,
  loginFailureReason,
  NETWORK_CODES,
  NETWORK_MESSAGES,
  STORAGE_CODES,
  STORAGE_MESSAGES,
  type LoginFailureFamily
} from "@src/ipc/handlers/loginFailureReason"

/**
 * The mapping the LOGIN handler logs instead of the caught error's message
 * (issue #352). Two properties matter here, and they pull against each other:
 * the answer has to stay useful enough to debug a field report from, and it
 * has to be impossible for any part of the thrown error to ride out in it.
 *
 * Every password below is a placeholder that exists only to be asserted
 * absent.
 */
describe("loginFailureReason names what went wrong", () => {
  for (const [message, expected] of [
    ["Network request timed out", "timeout"],
    ["Network response is too large", "response-too-large"],
    ["Network response was aborted", "response-aborted"]
  ] as const) {
    it(`reads "${message}" as ${expected}`, () => {
      assert.equal(loginFailureReason(new Error(message)), expected)
    })
  }

  it("names the HTTP failure, so a 503 outage is not read as a wrong password", () => {
    assert.equal(loginFailureReason(new Error("Network request failed with status 401")), "http-unauthorized")
    assert.equal(loginFailureReason(new Error("Network request failed with status 429")), "http-rate-limited")
    assert.equal(loginFailureReason(new Error("Network request failed with status 503")), "http-unavailable")
  })

  it("never writes the status digits, which the response picks and a password can equal", () => {
    // `network.ts` builds this message from the response's own status line,
    // and `assertString` accepts `503` as a password, so a token built by
    // splicing the digits in puts that password in the log the moment the
    // service goes down. Every token below is a literal from the module.
    for (const status of ["401", "403", "429", "500", "503", "418", "599", "302", "unknown"]) {
      const reason = loginFailureReason(new Error(`Network request failed with status ${status}`))
      assert.equal(reason.includes(status), false, `the status digits reached the reason: ${reason}`)
    }
  })

  it("degrades an unlisted status to its range, and anything else to http-other", () => {
    assert.equal(loginFailureReason(new Error("Network request failed with status 418")), "http-4xx")
    assert.equal(loginFailureReason(new Error("Network request failed with status 599")), "http-5xx")
    assert.equal(loginFailureReason(new Error("Network request failed with status 302")), "http-other")
    assert.equal(loginFailureReason(new Error("Network request failed with status unknown")), "http-other")
  })

  it("names the system error code when the socket is what failed", () => {
    assert.equal(loginFailureReason(Object.assign(new Error("getaddrinfo ENOTFOUND auth3.vintagestory.at"), { code: "ENOTFOUND" })), "network-ENOTFOUND")
    assert.equal(loginFailureReason(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), "network-ECONNRESET")
    assert.equal(loginFailureReason(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" })), "network-CERT_HAS_EXPIRED")
    assert.equal(loginFailureReason(Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })), "network-UNABLE_TO_VERIFY_LEAF_SIGNATURE")
  })

  it("falls back to the class name when nothing recognises the message", () => {
    assert.equal(loginFailureReason(new Error("something nobody has seen before")), "unclassified-Error")
    assert.equal(loginFailureReason(new TypeError("x is not a function")), "unclassified-TypeError")
  })

  it("says so when what was thrown is not an Error at all", () => {
    for (const thrown of ["a bare string", 42, null, undefined, { message: "an object" }]) assert.equal(loginFailureReason(thrown), "non-error-throw")
  })
})

/**
 * The account-store write and the network round trip sit under the same catch
 * in the handler, so without a marker a failing disk is reported as a failing
 * connection. `AccountStorageFailure` is that marker, and these pin that it
 * decides the whole answer.
 */
describe("loginFailureReason tells a storage failure from a network one", () => {
  for (const [message, expected] of [
    ["Secure account storage is unavailable", "secure-storage-unavailable"],
    ["A system password store is required for account storage", "no-system-password-store"]
  ] as const) {
    it(`reads "${message}" as ${expected}`, () => {
      assert.equal(loginFailureReason(new AccountStorageFailure(new Error(message))), expected)
    })
  }

  it("names a full disk as storage, not as a network failure", () => {
    const full = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })

    assert.equal(loginFailureReason(new AccountStorageFailure(full)), "storage-no-space")
    assert.equal(loginFailureReason(new AccountStorageFailure(Object.assign(new Error("quota exceeded"), { code: "EDQUOT" }))), "storage-no-space")
  })

  it("names a refused write as a permission problem, not as a network failure", () => {
    assert.equal(loginFailureReason(new AccountStorageFailure(Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" }))), "storage-permission")
    assert.equal(loginFailureReason(new AccountStorageFailure(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }))), "storage-permission")
    assert.equal(loginFailureReason(new AccountStorageFailure(Object.assign(new Error("read-only file system"), { code: "EROFS" }))), "storage-permission")
  })

  it("keeps an unrecognised storage failure on the storage side", () => {
    assert.equal(loginFailureReason(new AccountStorageFailure(new Error("keyring said no"))), "storage-other")
    assert.equal(loginFailureReason(new AccountStorageFailure("a bare string")), "storage-other")
    // The same code on both sides has to land on different tokens, which is the
    // whole point of the marker: this is the misdiagnosis the split removes.
    const timedOut = Object.assign(new Error("boom"), { code: "ETIMEDOUT" })
    assert.equal(loginFailureReason(timedOut), "network-ETIMEDOUT")
    assert.equal(loginFailureReason(new AccountStorageFailure(timedOut)), "storage-other")
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

  it("never logs the value of `code`, even when the secret is shaped exactly like a Node code", () => {
    // `code` is writable, so its shape proves nothing about where it came
    // from: a screaming-snake-case password is a valid password. Only being
    // in the allowlist makes a code loggable, and what is logged then is the
    // table's own string, never this value.
    for (const secret of ["PASSWORD123", "CORRECT_HORSE_9", "E".repeat(24), `posting ${PASSWORD}`, PASSWORD]) {
      const reason = loginFailureReason(Object.assign(new Error("boom"), { code: secret }))

      assert.equal(reason.includes(secret), false, `the code reached the reason: ${reason}`)
      assert.equal(reason, "network-other")
    }

    assert.equal(loginFailureReason(Object.assign(new Error("boom"), { code: 42 })), "unclassified-Error")
  })

  it("never logs the value of `name`, even when the secret is shaped exactly like a class name", () => {
    // Same argument as `code`: `name` is writable too, and an identifier-shaped
    // name is a perfectly ordinary passphrase.
    for (const secret of ["CorrectHorseBatteryStaple", "placeholderSecret9", `Error: while sending ${PASSWORD}`]) {
      const named = new Error("boom")
      named.name = secret

      const reason = loginFailureReason(named)
      assert.equal(reason.includes(secret), false, `the name reached the reason: ${reason}`)
      assert.equal(reason, "unclassified")
    }

    const empty = new Error("boom")
    empty.name = ""
    assert.equal(loginFailureReason(empty), "unclassified")
  })

  it("carries nothing out of a storage failure's own fields either", () => {
    const secret = Object.assign(new Error(`writing ${PASSWORD}`), { code: "PASSWORD123" })
    secret.name = "CorrectHorseBatteryStaple"

    const reason = loginFailureReason(new AccountStorageFailure(secret))

    assert.equal(reason.includes("PASSWORD123"), false)
    assert.equal(reason.includes("CorrectHorseBatteryStaple"), false)
    assert.equal(reason.includes(PASSWORD), false)
    assert.equal(reason, "storage-other")
  })

  it("matches the status message whole, so a longer one is not sliced for its middle", () => {
    const reason = loginFailureReason(new Error(`Network request failed with status 500 for body ${PASSWORD}`))

    assert.equal(reason.includes(PASSWORD), false)
    // Anchored, so a message that merely starts like the known one is not
    // matched and sliced: it falls through to the class name instead.
    assert.equal(reason, "unclassified-Error")
  })
})

/**
 * A table walk over every token `loginFailureReason` can actually emit (issue #481), read
 * straight out of its own tables rather than guessed at, so this list cannot go stale on its
 * own. `EXPECTED_FAMILY` is written independently of `loginFailureFamily`'s internal sets: a
 * token missing from it fails the completeness check below before it can silently read as
 * `unknown`, which is the failure mode this test exists to catch. A future token added to one of
 * the tables therefore has to be given a family here, even if that family is a deliberate
 * `unknown`, rather than falling through unnoticed.
 */
describe("loginFailureFamily places every token loginFailureReason can emit", () => {
  const ALL_REASON_TOKENS = new Set<string>([
    ...NETWORK_MESSAGES.values(),
    ...NETWORK_CODES.values(),
    ...HTTP_STATUSES.values(),
    "http-4xx",
    "http-5xx",
    "http-other",
    ...STORAGE_MESSAGES.values(),
    ...STORAGE_CODES.values(),
    "storage-other",
    ...ERROR_NAMES.values(),
    "unclassified",
    "non-error-throw",
    "network-other"
  ])

  const EXPECTED_FAMILY: Record<string, LoginFailureFamily> = {
    // Could not reach the service, or never heard back from it.
    timeout: "network-unreachable",
    "response-aborted": "network-unreachable",
    "http-request-timeout": "network-unreachable",
    "http-gateway-timeout": "network-unreachable",
    "network-ENOTFOUND": "network-unreachable",
    "network-EAI_AGAIN": "network-unreachable",
    "network-ECONNREFUSED": "network-unreachable",
    "network-ECONNRESET": "network-unreachable",
    "network-ECONNABORTED": "network-unreachable",
    "network-EPIPE": "network-unreachable",
    "network-ETIMEDOUT": "network-unreachable",
    "network-EHOSTUNREACH": "network-unreachable",
    "network-ENETUNREACH": "network-unreachable",
    "network-ENETDOWN": "network-unreachable",
    "network-EPROTO": "network-unreachable",
    "network-ERR_SOCKET_CONNECTION_TIMEOUT": "network-unreachable",
    "network-ERR_STREAM_PREMATURE_CLOSE": "network-unreachable",
    // A certificate this machine would not accept.
    "network-CERT_HAS_EXPIRED": "certificate-error",
    "network-CERT_NOT_YET_VALID": "certificate-error",
    "network-UNABLE_TO_VERIFY_LEAF_SIGNATURE": "certificate-error",
    "network-UNABLE_TO_GET_ISSUER_CERT_LOCALLY": "certificate-error",
    "network-SELF_SIGNED_CERT_IN_CHAIN": "certificate-error",
    "network-DEPTH_ZERO_SELF_SIGNED_CERT": "certificate-error",
    "network-ERR_TLS_CERT_ALTNAME_INVALID": "certificate-error",
    // The service answered, but with a failure that is its own to fix.
    "http-server-error": "service-error",
    "http-bad-gateway": "service-error",
    "http-unavailable": "service-error",
    "http-5xx": "service-error",
    // An HTTP-level refusal of the account itself, outside the ordinary envelope.
    "http-unauthorized": "account-restricted",
    "http-forbidden": "account-restricted",
    "http-rate-limited": "account-restricted",
    // Everything else: not confidently any of the four, so the generic failure stands.
    "response-too-large": "unknown",
    "http-bad-request": "unknown",
    "http-not-found": "unknown",
    "http-4xx": "unknown",
    "http-other": "unknown",
    "network-other": "unknown",
    "secure-storage-unavailable": "unknown",
    "no-system-password-store": "unknown",
    "storage-no-space": "unknown",
    "storage-permission": "unknown",
    "storage-locked": "unknown",
    "storage-io": "unknown",
    "storage-other": "unknown",
    "unclassified-Error": "unknown",
    "unclassified-TypeError": "unknown",
    "unclassified-RangeError": "unknown",
    "unclassified-SyntaxError": "unknown",
    "unclassified-ReferenceError": "unknown",
    "unclassified-AbortError": "unknown",
    unclassified: "unknown",
    "non-error-throw": "unknown"
  }

  it("has a recorded expectation for every token the module's own tables can produce", () => {
    const unrecorded = [...ALL_REASON_TOKENS].filter((token) => !(token in EXPECTED_FAMILY))

    assert.deepEqual(unrecorded, [], `token(s) with no recorded family, so they would silently fall back to "unknown": ${unrecorded.join(", ")}`)
  })

  it("never records an expectation for a token none of the tables can actually produce", () => {
    // The other direction: a stale entry here would hide a table entry that was renamed or
    // removed, and this test would keep passing on a token nothing can emit any more.
    const stale = Object.keys(EXPECTED_FAMILY).filter((token) => !ALL_REASON_TOKENS.has(token))

    assert.deepEqual(stale, [], `recorded token(s) no table can actually produce: ${stale.join(", ")}`)
  })

  it("classifies every token exactly as recorded", () => {
    const mismatched = Object.entries(EXPECTED_FAMILY)
      .filter(([token, expected]) => loginFailureFamily(token) !== expected)
      .map(([token, expected]) => `${token}: expected ${expected}, got ${loginFailureFamily(token)}`)

    assert.deepEqual(mismatched, [], mismatched.join("; "))
  })
})
