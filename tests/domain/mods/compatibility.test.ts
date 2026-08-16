import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { evaluateModCompatibility } from "../../../src/domain/mods/compatibility"

describe("evaluateModCompatibility", () => {
  it("declares a release whose tags name the exact game version", () => {
    assert.equal(evaluateModCompatibility(["1.19.5", "1.19.6"], "1.19.6"), "declared")
  })

  it("falls back to the same minor series when no tag matches exactly", () => {
    assert.equal(evaluateModCompatibility(["1.19.5"], "1.19.6"), "same-minor")
  })

  it("prefers the exact match even when a same-minor tag is also present", () => {
    assert.equal(evaluateModCompatibility(["1.19.5", "1.19.6"], "1.19.6"), "declared")
  })

  it("names a release with no tag anywhere near this series as undeclared, not incompatible", () => {
    assert.equal(evaluateModCompatibility(["1.18.0"], "1.19.6"), "undeclared")
  })

  it("names a release with no tags at all as undeclared", () => {
    assert.equal(evaluateModCompatibility([], "1.19.6"), "undeclared")
  })

  it("treats a patch-only difference as the same minor series", () => {
    assert.equal(evaluateModCompatibility(["1.19.0", "1.19.99"], "1.19.6"), "same-minor")
  })
})
