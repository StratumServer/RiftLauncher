import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { invalidPayloadResult, saveOutcomeToResult, unauthorizedPathResult } from "../../src/ipc/handlers/saveConfigOutcome"

describe("invalidPayloadResult", () => {
  it("names the payload refusal", () => {
    assert.deepEqual(invalidPayloadResult(), { ok: false, reason: "invalid-payload" })
  })
})

describe("unauthorizedPathResult", () => {
  it("names the path-authorization refusal", () => {
    assert.deepEqual(unauthorizedPathResult(), { ok: false, reason: "unauthorized-path" })
  })
})

describe("saveOutcomeToResult", () => {
  it("carries a successful write through as ok", () => {
    assert.deepEqual(saveOutcomeToResult(true), { ok: true })
  })

  it("names a failed write as write-failed", () => {
    assert.deepEqual(saveOutcomeToResult(false), { ok: false, reason: "write-failed" })
  })
})
