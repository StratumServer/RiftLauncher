import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { rankModsByTextRelevance } from "../../../src/domain/mods/searchRanking"

function aMod(name: string): { name: string } {
  return { name }
}

describe("rankModsByTextRelevance", () => {
  it("puts a name starting with the text first, ahead of the API's own order", () => {
    const mods = [aMod("Thermal HUD"), aMod("TinkerTailor Immersive Backpacks"), aMod("Immersive Herbicide"), aMod("Immersive Path Building")]

    const ranked = rankModsByTextRelevance(mods, "Immersive")

    assert.deepEqual(
      ranked.map((mod) => mod.name),
      ["Immersive Herbicide", "Immersive Path Building", "TinkerTailor Immersive Backpacks", "Thermal HUD"]
    )
  })

  it("keeps mods tied on the same rank in their original (API) order", () => {
    const mods = [aMod("Immersive Woodworking"), aMod("Immersive Fibercraft"), aMod("Salty's Immersive: Lanterns")]

    const ranked = rankModsByTextRelevance(mods, "Immersive")

    assert.deepEqual(
      ranked.map((mod) => mod.name),
      ["Immersive Woodworking", "Immersive Fibercraft", "Salty's Immersive: Lanterns"]
    )
  })

  it("matches case-insensitively", () => {
    const mods = [aMod("Other Mod"), aMod("immersive lighting")]

    const ranked = rankModsByTextRelevance(mods, "Immersive")

    assert.equal(ranked[0]?.name, "immersive lighting")
  })

  it("returns the list untouched for blank text", () => {
    const mods = [aMod("Zebra"), aMod("Apple")]

    assert.deepEqual(rankModsByTextRelevance(mods, "  "), mods)
  })
})
