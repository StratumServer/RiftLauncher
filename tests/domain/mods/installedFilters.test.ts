import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  filterInstalledMods,
  hasActiveInstalledModFilters,
  installedModAuthors,
  installedModGameVersions,
  installedModTags,
  matchesInstalledModFilters,
  NO_INSTALLED_MOD_FILTERS
} from "../../../src/domain/mods/installedFilters"
import type { InstalledModFilters } from "../../../src/domain/mods/installedFilters"

/** One scanned mod, carrying only the fields the filters read. */
function aMod(name: string, extra: Partial<InstalledModType> = {}): InstalledModType {
  return { name, modid: name.toLowerCase(), version: "1.0.0", path: `/mods/${name}.zip`, enabled: true, ...extra }
}

/** A ModDB detail carrying category tags and each release's game-version tags. */
function aDetail(tags: string[], releaseTags: string[][]): DownloadableModType {
  return {
    modid: 1,
    assetid: 1,
    name: "detail",
    text: "",
    author: "",
    urlalias: null,
    homepageurl: null,
    sourcecodeurl: null,
    downloads: 0,
    follows: 0,
    trendingpoints: 0,
    comments: 0,
    side: "both",
    createdat: "",
    tags,
    releases: releaseTags.map((releaseTag, index) => ({
      releaseid: index,
      mainfile: "",
      filename: "",
      fileid: index,
      downloads: 0,
      tags: releaseTag,
      modidstr: "detail",
      modversion: `1.${index}.0`,
      created: "",
      changelog: ""
    }))
  }
}

const filters = (over: Partial<InstalledModFilters> = {}): InstalledModFilters => ({ ...NO_INSTALLED_MOD_FILTERS, ...over })
const names = (mods: InstalledModType[]): string[] => mods.map((mod) => mod.name)

describe("the options the installed mod filters offer", () => {
  it("lists every author the scan credits, not only the first one on each mod", () => {
    const mods = [aMod("Alpha", { authors: ["Zed", "Ann"] }), aMod("Beta", { authors: ["Bob"] })]
    assert.deepEqual(installedModAuthors(mods), ["Ann", "Bob", "Zed"])
  })

  it("offers one row for an author two mods spell differently", () => {
    const mods = [aMod("Alpha", { authors: ["Cal"] }), aMod("Beta", { authors: ["cal"] })]
    assert.deepEqual(installedModAuthors(mods), ["Cal"])
  })

  it("offers no author for a mod with no authors key, and does not throw over it", () => {
    assert.deepEqual(installedModAuthors([aMod("Zeta")]), [])
  })

  it("reads tags off the ModDB detail, since modinfo.json carries none", () => {
    const mods = [aMod("Alpha", { _mod: aDetail(["storage", "qol"], [["1.20.0"]]) }), aMod("Zeta")]
    assert.deepEqual(installedModTags(mods), ["qol", "storage"])
  })

  it("offers no tag at all for a scan the ModDB answered for none of", () => {
    assert.deepEqual(installedModTags([aMod("Zeta"), aMod("Eta")]), [])
  })

  it("offers the game versions the releases declare, not the mods' own version numbers", () => {
    const mods = [aMod("Alpha", { version: "1.0.0", _mod: aDetail([], [["1.20.4"]]) }), aMod("Beta", { version: "2.0.0", _mod: aDetail([], [["1.19.4"], ["1.20.0"]]) })]
    assert.deepEqual(installedModGameVersions(mods), ["1.20.4", "1.20.0", "1.19.4"])
  })

  it("orders the game versions by number rather than by text", () => {
    const mods = [aMod("Alpha", { _mod: aDetail([], [["1.9.0"], ["1.10.0"]]) })]
    assert.deepEqual(installedModGameVersions(mods), ["1.10.0", "1.9.0"])
  })

  it("keeps a release tag that is not a version number out of the dropdown", () => {
    const mods = [aMod("Alpha", { _mod: aDetail([], [["1.20.0", "unstable"]]) })]
    assert.deepEqual(installedModGameVersions(mods), ["1.20.0"])
  })

  it("offers no game version for a scan the ModDB answered for none of", () => {
    assert.deepEqual(installedModGameVersions([aMod("Zeta")]), [])
  })
})

describe("matching one installed mod against the filters", () => {
  const alpha = aMod("Alpha", { authors: ["Zed", "Ann"], _mod: aDetail(["storage", "qol"], [["1.20.4"]]) })
  const beta = aMod("Beta", { authors: ["Bob"], _mod: aDetail(["storage"], [["1.19.4"]]) })
  const gamma = aMod("Gamma", { authors: ["ann"], _mod: aDetail(["qol"], [["1.20.0"], ["1.19.4"]]) })
  const zeta = aMod("Zeta")
  const all = [alpha, beta, gamma, zeta]

  it("keeps every mod when nothing is set", () => {
    assert.deepEqual(names(filterInstalledMods(all, NO_INSTALLED_MOD_FILTERS)), ["Alpha", "Beta", "Gamma", "Zeta"])
    assert.equal(hasActiveInstalledModFilters(NO_INSTALLED_MOD_FILTERS), false)
  })

  it("matches an author credited second, not only the one credited first", () => {
    assert.deepEqual(names(filterInstalledMods(all, filters({ author: "Ann" }))), ["Alpha", "Gamma"])
  })

  it("matches an author whose mod spells the name in another case", () => {
    assert.deepEqual(names(filterInstalledMods(all, filters({ author: "ANN" }))), ["Alpha", "Gamma"])
    assert.deepEqual(names(filterInstalledMods(all, filters({ author: "bob" }))), ["Beta"])
  })

  it("leaves a mod with no authors key out of an author filter instead of throwing", () => {
    assert.doesNotThrow(() => filterInstalledMods(all, filters({ author: "Ann" })))
    assert.equal(matchesInstalledModFilters(zeta, filters({ author: "Ann" })), false)
  })

  it("asks for every selected tag, so a second tag narrows what is left", () => {
    assert.deepEqual(names(filterInstalledMods(all, filters({ tags: ["storage"] }))), ["Alpha", "Beta"])
    assert.deepEqual(names(filterInstalledMods(all, filters({ tags: ["storage", "qol"] }))), ["Alpha"])
    assert.deepEqual(names(filterInstalledMods(all, filters({ tags: ["qol", "storage"] }))), ["Alpha"])
  })

  it("ignores case on a tag the same way it does on an author", () => {
    assert.deepEqual(names(filterInstalledMods(all, filters({ tags: ["STORAGE"] }))), ["Alpha", "Beta"])
  })

  it("drops a mod the ModDB has no entry for out of a tag filter", () => {
    assert.equal(matchesInstalledModFilters(zeta, filters({ tags: ["storage"] })), false)
  })

  it("matches the game version a release declares, not the mod's own version number", () => {
    assert.deepEqual(names(filterInstalledMods(all, filters({ gameVersion: "1.19.4" }))), ["Beta", "Gamma"])
  })

  it("counts a release tagged for the same minor series, matching the split this page already shows", () => {
    // Alpha declares 1.20.4 only. useGetCompleteInstalledMods treats that as compatible with a
    // 1.20.0 install, so the filter has to agree with the sections underneath it.
    assert.deepEqual(names(filterInstalledMods(all, filters({ gameVersion: "1.20.0" }))), ["Alpha", "Gamma"])
  })

  it("drops a mod whose releases name another series entirely", () => {
    assert.equal(matchesInstalledModFilters(beta, filters({ gameVersion: "1.20.0" })), false)
  })

  it("drops a mod the ModDB has no entry for out of a game version filter", () => {
    assert.equal(matchesInstalledModFilters(zeta, filters({ gameVersion: "1.20.0" })), false)
  })

  it("asks a mod to clear all three axes at once rather than any one of them", () => {
    // Ann covers Alpha and Gamma. 1.19.4 covers Beta and Gamma. Together they leave Gamma.
    assert.deepEqual(names(filterInstalledMods(all, filters({ author: "Ann", gameVersion: "1.19.4" }))), ["Gamma"])
    assert.deepEqual(names(filterInstalledMods(all, filters({ author: "Bob", tags: ["qol"] }))), [])
  })

  it("calls each axis active on its own", () => {
    assert.equal(hasActiveInstalledModFilters(filters({ author: "Ann" })), true)
    assert.equal(hasActiveInstalledModFilters(filters({ tags: ["storage"] })), true)
    assert.equal(hasActiveInstalledModFilters(filters({ gameVersion: "1.20.0" })), true)
  })
})

describe("real mod database shapes (#370)", () => {
  // The detail endpoint returns exactly this for Vanilla Variants: a null among the category tags.
  // The documented shape says strings only, and the launcher used to believe it.
  const nullTag = ["Cosmetics", "Crafting", "Storage", null] as unknown as string[]
  const vanillaVariants = aMod("VanillaVariants", { _mod: aDetail(nullTag, [["1.21.0", "1.21.1"]]) })

  it("collects category tags past a null in the list instead of throwing", () => {
    assert.deepEqual(installedModTags([vanillaVariants]), ["Cosmetics", "Crafting", "Storage"])
  })

  it("still matches the tags that are real when a null sits beside them", () => {
    assert.equal(matchesInstalledModFilters(vanillaVariants, { ...NO_INSTALLED_MOD_FILTERS, tags: ["storage"] }), true)
    assert.equal(matchesInstalledModFilters(vanillaVariants, { ...NO_INSTALLED_MOD_FILTERS, tags: ["Food"] }), false)
  })

  it("collects game versions past a null in a release's tags", () => {
    const releaseWithNull = [["1.21.0", null, "1.21.1"]] as unknown as string[][]
    const mod = aMod("Odd", { _mod: aDetail(["Other"], releaseWithNull) })
    assert.deepEqual(installedModGameVersions([mod]), ["1.21.1", "1.21.0"])
    assert.equal(matchesInstalledModFilters(mod, { ...NO_INSTALLED_MOD_FILTERS, gameVersion: "1.21.0" }), true)
  })

  it("ignores an author entry that is not a string", () => {
    const mod = aMod("Odd", { authors: ["Ann", null, 42, "Bob"] as unknown as string[] })
    assert.deepEqual(installedModAuthors([mod]), ["Ann", "Bob"])
    assert.equal(matchesInstalledModFilters(mod, { ...NO_INSTALLED_MOD_FILTERS, author: "bob" }), true)
  })

  it("reads a tags field that is not a list as no tags, and releases that are not a list as no releases", () => {
    const detail = aDetail([], [])
    const mod = aMod("Odd", { _mod: { ...detail, tags: "Cosmetics" as unknown as string[], releases: null as unknown as typeof detail.releases } })
    assert.deepEqual(installedModTags([mod]), [])
    assert.deepEqual(installedModGameVersions([mod]), [])
    assert.equal(matchesInstalledModFilters(mod, { ...NO_INSTALLED_MOD_FILTERS, tags: ["cosmetics"] }), false)
    assert.equal(matchesInstalledModFilters(mod, { ...NO_INSTALLED_MOD_FILTERS, gameVersion: "1.21.0" }), false)
    assert.equal(filterInstalledMods([mod], NO_INSTALLED_MOD_FILTERS).length, 1)
  })
})
