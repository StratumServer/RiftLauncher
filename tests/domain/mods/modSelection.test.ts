import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { addPicks, MAX_MOD_SELECTION, modSelectionEntries, togglePick } from "../../../src/domain/mods/modSelection"
import type { ModPick } from "../../../src/domain/mods/modSelection"

function pick(listingId: number, name = `Mod ${listingId}`, modidstrs: string[] = [`mod${listingId}`]): ModPick {
  return { listingId, name, modidstrs }
}

function picks(count: number, from = 1): ModPick[] {
  return Array.from({ length: count }, (_, index) => pick(from + index))
}

describe("togglePick", () => {
  it("adds, then removes, by listing id; two listings sharing a name are two picks", () => {
    const original = pick(1, "Better Ruins")
    const fork = pick(2, "Better Ruins")

    const both = togglePick(togglePick([], original), fork)
    assert.deepEqual(both, [original, fork])

    assert.deepEqual(togglePick(both, pick(1, "Better Ruins")), [fork])
  })

  it("refuses an add at MAX_MOD_SELECTION but still removes", () => {
    const full = picks(MAX_MOD_SELECTION)

    assert.equal(togglePick(full, pick(1000)).length, MAX_MOD_SELECTION)
    assert.equal(togglePick(full.slice(1), pick(1000)).length, MAX_MOD_SELECTION, "one under the cap still takes one more")

    const removed = togglePick(full, pick(7))
    assert.equal(removed.length, MAX_MOD_SELECTION - 1)
    assert.equal(
      removed.some((picked) => picked.listingId === 7),
      false
    )
  })
})

describe("addPicks", () => {
  it("appends only unpicked listings, in order, and stops exactly at the cap", () => {
    const current = picks(MAX_MOD_SELECTION - 2)
    const candidates = [pick(1), pick(500), pick(501), pick(502), pick(503)]

    const next = addPicks(current, candidates)

    assert.equal(next.length, MAX_MOD_SELECTION)
    assert.deepEqual(
      next.slice(-2).map((picked) => picked.listingId),
      [500, 501]
    )
    assert.deepEqual(next.slice(0, current.length), current)
  })

  it("never picks one listing twice, even when it is offered twice", () => {
    assert.deepEqual(
      addPicks([], [pick(3), pick(4), pick(3)]).map((picked) => picked.listingId),
      [3, 4]
    )
  })
})

describe("modSelectionEntries", () => {
  it("uses the installed copy's own mod id, the listing id and the listing name, and no version", () => {
    const { entries, leftOut } = modSelectionEntries([pick(123, "Better Ruins", ["betterruins"])], [{ modid: "primitivesurvival" }, { modid: "BetterRuins" }])

    assert.deepEqual(entries, [{ modid: "BetterRuins", listingId: 123, name: "Better Ruins" }])
    assert.equal("version" in (entries[0] as object), false)
    assert.equal(leftOut, 0)
  })

  it("keys a pick that is not installed by the listing's first mod id", () => {
    const { entries } = modSelectionEntries([pick(456, "Primitive Survival", ["primitivesurvival", "primsurv"])], [{ modid: "betterruinsplus" }])

    assert.deepEqual(entries, [{ modid: "primitivesurvival", listingId: 456, name: "Primitive Survival" }])
  })

  it("collapses two listings declaring one mod id to the first picked and counts one left out; two listings with one name and different ids stay two", () => {
    const original = pick(10, "Better Ruins", ["betterruins"])
    const continuation = pick(11, "Better Ruins Continued", ["betterruins"])
    const namesake = pick(12, "Better Ruins", ["betterruinsredux"])

    const { entries, leftOut } = modSelectionEntries([original, continuation, namesake], [])

    assert.deepEqual(
      entries.map((entry) => [entry.modid, entry.listingId]),
      [
        ["betterruins", 10],
        ["betterruinsredux", 12]
      ]
    )
    assert.equal(leftOut, 1)
  })

  it("collapses two picks that land on one installed copy through its casing", () => {
    const { entries, leftOut } = modSelectionEntries([pick(10, "Better Ruins", ["betterruins"]), pick(11, "Better Ruins Fork", ["BetterRuins"])], [{ modid: "BetterRuins" }])

    assert.deepEqual(
      entries.map((entry) => [entry.modid, entry.listingId]),
      [["BetterRuins", 10]]
    )
    assert.equal(leftOut, 1)
  })

  it("still yields an entry keyed by its listing id for a listing with no modidstrs", () => {
    const { entries } = modSelectionEntries([pick(789, "Mystery", [])], [])

    assert.deepEqual(entries, [{ modid: "789", listingId: 789, name: "Mystery" }])
  })
})
