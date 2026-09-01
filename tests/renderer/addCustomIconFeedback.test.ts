import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { describeAddCustomIconFailure } from "../../src/renderer/src/features/config/adapters/customIcon"

describe("describeAddCustomIconFailure", () => {
  it("keys an empty picker to its own sentence and stays out of the log", () => {
    assert.deepEqual(describeAddCustomIconFailure("no-file-selected"), { messageKey: "notifications.body.noFileSelected", logged: false })
  })

  it("keys a non-png to its own sentence", () => {
    assert.deepEqual(describeAddCustomIconFailure("unsupported-format"), { messageKey: "notifications.body.iconNotAPng", logged: false })
  })

  it("keys an unreadable source to its own sentence", () => {
    assert.deepEqual(describeAddCustomIconFailure("source-unavailable"), { messageKey: "notifications.body.iconSourceUnavailable", logged: false })
  })

  it("keys an oversized file to its own sentence", () => {
    assert.deepEqual(describeAddCustomIconFailure("too-large"), { messageKey: "notifications.body.iconTooLarge", logged: false })
  })

  it("keys a failed copy to its own sentence and logs it", () => {
    assert.deepEqual(describeAddCustomIconFailure("copy-failed"), { messageKey: "notifications.body.coulndtCopyIcon", logged: true })
  })

  it("keys a bridge failure to its own sentence and logs it", () => {
    assert.deepEqual(describeAddCustomIconFailure("bridge-failed"), { messageKey: "notifications.body.iconAddFailed", logged: true })
  })

  it("gives every reason a message key of its own", () => {
    const reasons = ["no-file-selected", "unsupported-format", "source-unavailable", "too-large", "copy-failed", "bridge-failed"] as const
    const keys = reasons.map((reason) => describeAddCustomIconFailure(reason).messageKey)
    assert.equal(new Set(keys).size, reasons.length, `two reasons share a message key: ${keys.join(", ")}`)
  })
})
