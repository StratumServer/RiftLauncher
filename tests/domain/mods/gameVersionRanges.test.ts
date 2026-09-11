import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { summarizeGameVersionTags } from "../../../src/domain/mods/gameVersionRanges"

/**
 * The catalog as `useGameVersionsLookup` hands it over: the ModDB's `/gameversions` list reversed,
 * so newest first. Shaped like the live one, pre-releases and all.
 */
const CATALOG = ["1.22.3", "1.22.2", "1.22.1", "1.22.0", "1.22.0-rc.1", "1.22.0-pre.1", "1.21.1", "1.21.0"]

/** What the cell would print, so a test reads like the row a player looks at. */
function summarize(tags: readonly string[], catalog: readonly string[] = CATALOG): string {
  return summarizeGameVersionTags(tags, catalog)
    .map((range) => (range.to === undefined ? range.from : `${range.from} to ${range.to}`))
    .join(", ")
}

describe("summarizeGameVersionTags", () => {
  it("collapses a run of three or more into the versions at its ends", () => {
    assert.equal(summarize(["1.22.1", "1.22.2", "1.22.3"]), "1.22.1 to 1.22.3")
  })

  it("writes a run of two out, since the range would be no shorter and says less", () => {
    assert.equal(summarize(["1.22.2", "1.22.3"]), "1.22.2, 1.22.3")
  })

  it("never bridges a version the release skipped", () => {
    // 1.22.1 is in the catalog and not in the tags, so the two sides stay apart: a range over the
    // gap would tell a player this release supports a version its author never ticked.
    assert.equal(summarize(["1.21.0", "1.21.1", "1.22.0", "1.22.2", "1.22.3"]), "1.21.0, 1.21.1, 1.22.0, 1.22.2, 1.22.3")
  })

  it("keeps a run going across the pre-releases it folded away", () => {
    // 1.21.1 and 1.22.1 sit either side of the folded candidates with nothing missing between them,
    // so what is left to print is one unbroken run of three rather than three separate entries.
    assert.equal(summarize(["1.21.1", "1.22.0-pre.1", "1.22.0-rc.1", "1.22.0", "1.22.1"]), "1.21.1 to 1.22.1")
  })

  it("folds the pre-releases and release candidates of a number the release also carries", () => {
    assert.equal(summarize(["1.22.0-pre.1", "1.22.0-rc.1", "1.22.0"]), "1.22.0")
  })

  it("keeps a pre-release whose own number the release does not carry", () => {
    // Folding this one into 1.22.0 would claim the finished version off a tag for a candidate.
    assert.equal(summarize(["1.22.0-pre.1", "1.22.0-rc.1"]), "1.22.0-pre.1, 1.22.0-rc.1")
  })

  it("does not let the pre-releases it folds swell the run they sit in", () => {
    // Four catalog entries in a row, two of them folded away. A run is measured in what it will
    // print, so this one is two versions long and gets written out rather than collapsed.
    assert.equal(summarize(["1.22.0-pre.1", "1.22.0-rc.1", "1.22.0", "1.22.1"]), "1.22.0, 1.22.1")
  })

  it("prints a tag the catalog does not know as it came", () => {
    assert.equal(summarize(["1.22.2", "1.22.3", "1.23.0"]), "1.22.2, 1.22.3, 1.23.0")
  })

  it("prints a tag the catalog does not know once, however often the release carries it", () => {
    // The tags the catalog knows dedupe through the set the walk reads, so a repeat of one it does
    // not know cannot be the half of the same cell that prints twice.
    assert.equal(summarize(["1.22.2", "1.23.0", "1.23.0"]), "1.22.2, 1.23.0")
  })

  it("puts a tag the catalog does not know after the versions it placed, old as that tag may be", () => {
    // Nothing says where 1.19.0 belongs, so it cannot join the climb: it trails what was placed
    // rather than being guessed into the middle of it.
    assert.equal(summarize(["1.19.0", "1.22.1", "1.22.2", "1.22.3"]), "1.22.1 to 1.22.3, 1.19.0")
  })

  it("summarises nothing for a release with no tags", () => {
    assert.deepEqual(summarizeGameVersionTags([], CATALOG), [])
  })

  it("falls back to one entry per tag, in the order they came, with no catalog to check against", () => {
    assert.equal(summarize(["1.22.3", "1.22.1", "1.22.2"], []), "1.22.3, 1.22.1, 1.22.2")
  })

  it("reads the same whatever order the ModDB returned the tags in", () => {
    assert.equal(summarize(["1.22.3", "1.22.0", "1.22.2", "1.22.1"]), "1.22.0 to 1.22.3")
  })
})
