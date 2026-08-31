import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { compareGameVersionsDesc } from "../../src/renderer/src/utils/gameVersionOrder"

/**
 * The comparator behind every VS Version list in the launcher. A version string
 * semver cannot parse used to throw out of the sort callback and take the page
 * down with it, so the unparseable arms matter as much as the ordering ones.
 */
describe("compareGameVersionsDesc", () => {
  it("puts the newer of two parseable versions first", () => {
    assert.ok(compareGameVersionsDesc("1.20.4", "1.19.8") < 0)
    assert.ok(compareGameVersionsDesc("1.19.8", "1.20.4") > 0)
    assert.equal(compareGameVersionsDesc("1.20.4", "1.20.4"), 0)
  })

  it("orders a pre-release under the release it precedes", () => {
    assert.ok(compareGameVersionsDesc("1.20.0", "1.20.0-rc.1") < 0)
  })

  it("sorts a version semver cannot parse after every parseable one", () => {
    assert.ok(compareGameVersionsDesc("Vintage Story 1.21.0", "1.19.8") > 0)
    assert.ok(compareGameVersionsDesc("1.19.8", "Vintage Story 1.21.0") < 0)
  })

  it("orders two unparseable versions alphabetically so the list stays stable", () => {
    assert.ok(compareGameVersionsDesc("Vintage Story 1.21.0", "Zed build") < 0)
    assert.ok(compareGameVersionsDesc("Zed build", "Vintage Story 1.21.0") > 0)
  })

  it("sorts a mixed list newest first with the unparseable entries last", () => {
    const sorted = ["Vintage Story 1.21.0", "1.19.8", "custom", "1.20.4"].sort(compareGameVersionsDesc)
    assert.deepEqual(sorted, ["1.20.4", "1.19.8", "custom", "Vintage Story 1.21.0"])
  })
})
