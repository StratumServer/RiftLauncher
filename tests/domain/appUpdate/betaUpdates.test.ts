/**
 * The four rows that decide whether a launch is offered betas, plus the two helpers underneath.
 *
 * The pair that matters most is a stored answer of null: the running version has to keep deciding,
 * because that is what electron-updater does on its own and what every install already lives with.
 * Flip that fallback either way and two of these rows fail.
 */
import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { DEFAULT_RECEIVE_BETA_UPDATES, isPrereleaseVersion, normalizeReceiveBetaUpdates, resolveAllowPrerelease } from "@domain/appUpdate/betaUpdates"

describe("isPrereleaseVersion", () => {
  it("reads the prerelease components semver puts after the first dash", () => {
    assert.equal(isPrereleaseVersion("1.7.0-beta.3"), true)
    assert.equal(isPrereleaseVersion("2.0.0-rc.1"), true)
    assert.equal(isPrereleaseVersion("1.7.0-0"), true)
  })

  it("calls a plain release, and one carrying build metadata, a release", () => {
    assert.equal(isPrereleaseVersion("1.7.0"), false)
    assert.equal(isPrereleaseVersion("1.7.0+build-2"), false)
    assert.equal(isPrereleaseVersion(""), false)
  })

  it("still finds a prerelease that also carries build metadata", () => {
    assert.equal(isPrereleaseVersion("1.7.0-beta.3+2024"), true)
  })
})

describe("normalizeReceiveBetaUpdates", () => {
  it("keeps an explicit answer, both ways round", () => {
    assert.equal(normalizeReceiveBetaUpdates(true), true)
    assert.equal(normalizeReceiveBetaUpdates(false), false)
  })

  it("reads anything else, a config written before the field existed included, as no answer yet", () => {
    for (const value of [undefined, null, "true", "false", 1, 0, {}, [true]]) {
      assert.equal(normalizeReceiveBetaUpdates(value), DEFAULT_RECEIVE_BETA_UPDATES, String(value))
    }
    assert.equal(DEFAULT_RECEIVE_BETA_UPDATES, null)
  })
})

describe("resolveAllowPrerelease", () => {
  it("leaves a stable install alone while nobody has answered", () => {
    assert.equal(resolveAllowPrerelease(null, "1.7.0"), false)
  })

  it("offers betas to a stable install that asked for them", () => {
    assert.equal(resolveAllowPrerelease(true, "1.7.0"), true)
  })

  it("keeps offering betas to an install already running one, unasked", () => {
    assert.equal(resolveAllowPrerelease(null, "1.7.0-beta.3"), true)
  })

  it("stops offering them to a beta install that opted out", () => {
    assert.equal(resolveAllowPrerelease(false, "1.7.0-beta.3"), false)
  })
})
