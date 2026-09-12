import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { evaluateModCompatibility, findModUpdate, newestCompatibleRelease } from "../../../src/domain/mods/compatibility"

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

/** One release, newest-first lists of which the ModDB serves. */
function aRelease(modversion: string, ...tags: string[]): { modversion: string; tags: string[] } {
  return { modversion, tags }
}

describe("newestCompatibleRelease", () => {
  it("takes the first declared or same-minor release in newest-first order", () => {
    const releases = [aRelease("3.0.0", "1.22.0"), aRelease("2.0.0", "1.21.3"), aRelease("1.0.0", "1.21.0")]

    // 2.0.0 is only same-minor for 1.21.0 and still wins over the older, exactly tagged 1.0.0.
    assert.equal(newestCompatibleRelease(releases, "1.21.0")?.modversion, "2.0.0")
  })

  it("returns the release object itself, so a caller keeps every field it carries", () => {
    const releases = [{ modversion: "1.0.0", tags: ["1.21.0"], mainfile: "https://mods.example/a.zip" }]

    assert.equal(newestCompatibleRelease(releases, "1.21.0"), releases[0])
  })

  it("returns undefined when nothing is tagged for the series, with no fallback to the newest release", () => {
    assert.equal(newestCompatibleRelease([aRelease("2.0.0", "1.19.8"), aRelease("1.0.0", "1.19.0")], "1.21.0"), undefined)
  })

  it("returns undefined for an Installation with no game version set", () => {
    assert.equal(newestCompatibleRelease([aRelease("2.0.0", "1.21.0")], ""), undefined)
  })

  it("returns undefined for a Mod with no releases", () => {
    assert.equal(newestCompatibleRelease([], "1.21.0"), undefined)
  })
})

describe("findModUpdate", () => {
  it("offers the newest tagged release above the installed one and records the untagged one past it", () => {
    const releases = [aRelease("2.0.0", "1.19.0"), aRelease("1.5.0", "1.21.0")]

    assert.deepEqual(findModUpdate("1.0.0", releases, "1.21.0"), { updatableTo: "1.5.0", lastVersion: "2.0.0" })
  })

  it("offers nothing tagged once the installed copy is already the newest tagged release", () => {
    const releases = [aRelease("2.0.0", "1.19.0"), aRelease("1.5.0", "1.21.0")]

    assert.deepEqual(findModUpdate("1.5.0", releases, "1.21.0"), { lastVersion: "2.0.0" })
  })

  it("never offers a release older than the installed copy, tagged for the series or not", () => {
    assert.deepEqual(findModUpdate("2.0.0", [aRelease("1.5.0", "1.21.0")], "1.21.0"), {})
    // Untagged releases only become lastVersion when they are newer: the installed copy's own
    // version and an older one both leave the Mod out of "Mods with incompatible updates".
    assert.deepEqual(findModUpdate("2.0.0", [aRelease("2.0.0", "1.19.0"), aRelease("1.5.0", "1.19.0")], "1.21.0"), {})
  })

  it("stops at the first tagged release above the installed one rather than the last", () => {
    const releases = [aRelease("1.5.0", "1.21.0"), aRelease("1.2.0", "1.21.0")]

    assert.deepEqual(findModUpdate("1.0.0", releases, "1.21.0"), { updatableTo: "1.5.0" })
  })

  it("keeps the newest untagged release as lastVersion, not an older one", () => {
    const releases = [aRelease("3.0.0", "1.18.0"), aRelease("2.0.0", "1.19.0")]

    assert.deepEqual(findModUpdate("1.0.0", releases, "1.21.0"), { lastVersion: "3.0.0" })
  })

  it("skips a release whose version semver cannot read instead of throwing on it", () => {
    const releases = [aRelease("nightly", "1.21.0"), aRelease("1.5.0", "1.21.0")]

    assert.deepEqual(findModUpdate("1.0.0", releases, "1.21.0"), { updatableTo: "1.5.0" })
  })

  it("offers nothing for an installed version semver cannot read, or none at all", () => {
    assert.deepEqual(findModUpdate("1.0", [aRelease("1.5.0", "1.21.0")], "1.21.0"), {})
    assert.deepEqual(findModUpdate("", [aRelease("1.5.0", "1.21.0")], "1.21.0"), {})
  })
})
