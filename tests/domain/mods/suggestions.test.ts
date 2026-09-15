import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { MAX_SUGGESTION_DETAIL_LOOKUPS, MAX_SUGGESTIONS, rankSuggestions, resolveSuggestions, type SuggestionInstallation } from "../../../src/domain/mods/suggestions"

const NOW = Date.parse("2026-09-15T12:00:00Z")

function listing(modid: number, name: string, overrides: Partial<DownloadableModOnListType> = {}): DownloadableModOnListType {
  return {
    modid,
    assetid: modid,
    downloads: 0,
    follows: 0,
    trendingpoints: 0,
    comments: 0,
    name,
    summary: "",
    modidstrs: [name.toLowerCase().replaceAll(" ", "-")],
    author: "Author",
    urlalias: null,
    side: "client",
    type: "mod",
    logo: "",
    tags: [],
    lastreleased: "2020-01-01",
    ...overrides
  }
}

function copy(modid: string, enabled = true): InstalledModType {
  return { name: modid, modid, version: "1.0.0", path: `/Mods/${modid}.zip`, enabled }
}

function installation(id: string, version = "1.22.7", mods: InstalledModType[] = []): SuggestionInstallation {
  return { id, version, mods }
}

function compatibleDetail(mod: DownloadableModOnListType): DownloadableModType {
  return {
    modid: mod.modid,
    assetid: mod.assetid,
    name: mod.name,
    urlalias: null,
    homepageurl: null,
    sourcecodeurl: null,
    trendingpoints: mod.trendingpoints,
    comments: mod.comments,
    createdat: "2026-01-01",
    tags: mod.tags,
    releases: [
      {
        releaseid: mod.modid,
        mainfile: `https://example.test/${mod.modid}.zip`,
        filename: `${mod.modid}.zip`,
        fileid: mod.modid,
        downloads: 0,
        tags: ["1.22.7"],
        modidstr: mod.modidstrs[0] ?? "",
        modversion: "1.0.0",
        created: "2026-01-01",
        changelog: ""
      }
    ]
  }
}

describe("rankSuggestions", () => {
  it("requires mod listings on the client or both side and excludes local, dismissed, and duplicate matches", () => {
    const candidates = rankSuggestions({
      catalog: [
        listing(1, "Local", { modidstrs: ["LOCAL"] }),
        listing(2, "Dismissed"),
        listing(3, "Several", { modidstrs: ["several"] }),
        listing(4, "Server", { side: "server" }),
        listing(5, "Pack", { type: "modpack" }),
        listing(6, "Empty identifier", { modidstrs: [""] }),
        listing(7, "Client"),
        listing(8, "Both", { side: "both" })
      ],
      installation: installation("current", "1.22.7", [copy("local"), copy("several"), copy("several", false)]),
      otherInstallations: [],
      dismissedListingIds: [2],
      targetGameVersion: "1.22.7",
      now: NOW
    })

    assert.deepEqual(
      candidates.map(({ mod }) => mod.modid),
      [6, 7, 8]
    )
  })

  it("puts an enabled compatible copy from another installation in its own top tier", () => {
    const reused = listing(1, "Already elsewhere")
    const disabled = listing(2, "Disabled elsewhere")
    const old = listing(3, "Old game elsewhere")
    const result = rankSuggestions({
      catalog: [reused, disabled, old],
      installation: installation("current"),
      otherInstallations: [
        installation("same-game", "1.22.6", [copy("already-elsewhere")]),
        installation("disabled", "1.22.7", [copy("disabled-elsewhere", false)]),
        installation("old-game", "1.21.9", [copy("old-game-elsewhere")])
      ],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })

    assert.equal(result[0]?.mod.modid, reused.modid)
    assert.equal(result[0]?.reason.kind, "other-installation")
    assert.notEqual(result.find((candidate) => candidate.mod.modid === disabled.modid)?.reason.kind, "other-installation")
    assert.notEqual(result.find((candidate) => candidate.mod.modid === old.modid)?.reason.kind, "other-installation")
  })

  it("scores each discovery signal in isolation and explains the winning signal", () => {
    const installedTag = listing(99, "Installed", { modidstrs: ["installed"], tags: ["Tweak"] })
    const tagMatch = listing(1, "Tag match", { tags: ["Tweak"] })
    const trending = listing(2, "Trending", { trendingpoints: 100 })
    const popular = listing(3, "Popular", { downloads: 100, follows: 10 })
    const recent = listing(4, "Recent", { lastreleased: "2026-09-14T12:00:00Z" })

    const result = rankSuggestions({
      catalog: [installedTag, tagMatch, trending, popular, recent],
      installation: installation("current", "1.22.7", [copy("installed")]),
      otherInstallations: [],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })

    const byId = new Map(result.map((candidate) => [candidate.mod.modid, candidate]))
    assert.equal(byId.get(tagMatch.modid)?.reason.kind, "matching-tags")
    assert.equal(byId.get(trending.modid)?.reason.kind, "trending")
    assert.equal(byId.get(popular.modid)?.reason.kind, "popular")
    assert.equal(byId.get(recent.modid)?.reason.kind, "recent")

    for (const candidate of result) {
      const fired =
        candidate.reason.kind === "matching-tags"
          ? candidate.signals.categoryOverlap > 0
          : candidate.reason.kind === "trending"
            ? candidate.signals.trending > 0
            : candidate.reason.kind === "popular"
              ? candidate.signals.popularity > 0
              : candidate.reason.kind === "recent"
                ? candidate.signals.recency > 0
                : candidate.reason.kind === "other-installation"
      assert.equal(fired, true, `${candidate.mod.name} explanation must name a fired signal`)
    }
  })

  it("uses bounded logarithmic popularity so one huge listing does not flatten the list", () => {
    const huge = listing(1, "Huge", { downloads: 10_000_000_000, follows: 10_000_000_000 })
    const tagMatch = listing(2, "Tag match", { tags: ["Tweak"] })
    const installedTag = listing(99, "Installed", { modidstrs: ["installed"], tags: ["Tweak"] })
    const result = rankSuggestions({
      catalog: [huge, tagMatch, installedTag],
      installation: installation("current", "1.22.7", [copy("installed")]),
      otherInstallations: [],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })

    assert.equal(result[0]?.mod.modid, tagMatch.modid)
    assert.ok((result.find((candidate) => candidate.mod.modid === huge.modid)?.signals.popularity ?? 1) <= 1)
  })

  it("uses the injected clock and a deterministic listing-id tie break", () => {
    const old = listing(1, "Old", { lastreleased: "2026-08-01" })
    const fresh = listing(2, "Fresh", { lastreleased: "2026-09-14" })
    const tiedHighId = listing(20, "High id")
    const tiedLowId = listing(10, "Low id")

    const byTime = rankSuggestions({
      catalog: [old, fresh],
      installation: installation("current"),
      otherInstallations: [],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })
    assert.equal(byTime[0]?.mod.modid, fresh.modid)

    const tied = rankSuggestions({
      catalog: [tiedHighId, tiedLowId],
      installation: installation("current"),
      otherInstallations: [],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })
    assert.deepEqual(
      tied.map(({ mod }) => mod.modid),
      [10, 20]
    )
  })
})

describe("resolveSuggestions", () => {
  it("stops after the detail budget when every ranked candidate is incompatible", async () => {
    const catalog = Array.from({ length: MAX_SUGGESTION_DETAIL_LOOKUPS + 3 }, (_, index) => listing(index + 1, `Mod ${index + 1}`))
    const ranked = rankSuggestions({
      catalog,
      installation: installation("current"),
      otherInstallations: [],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })
    const requested: number[] = []
    const result = await resolveSuggestions({
      candidates: ranked,
      targetGameVersion: "1.22.7",
      getDetail: async (listingId) => {
        requested.push(listingId)
        return { ...compatibleDetail(catalog[listingId - 1]!), releases: [] }
      }
    })

    assert.deepEqual(result, [])
    assert.equal(requested.length, MAX_SUGGESTION_DETAIL_LOOKUPS)
  })

  it("keeps accepted declared results in rank order and caps the row at six", async () => {
    const catalog = Array.from({ length: MAX_SUGGESTIONS + 2 }, (_, index) => listing(index + 1, `Mod ${index + 1}`))
    const ranked = rankSuggestions({
      catalog,
      installation: installation("current"),
      otherInstallations: [],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })
    const requested: number[] = []
    const result = await resolveSuggestions({
      candidates: ranked,
      targetGameVersion: "1.22.7",
      getDetail: async (listingId) => {
        requested.push(listingId)
        return compatibleDetail(catalog[listingId - 1]!)
      }
    })

    assert.deepEqual(
      result.map(({ mod }) => mod.modid),
      catalog.slice(0, MAX_SUGGESTIONS).map(({ modid }) => modid)
    )
    assert.equal(result.length, MAX_SUGGESTIONS)
    assert.deepEqual(
      requested,
      catalog.slice(0, MAX_SUGGESTIONS).map(({ modid }) => modid)
    )
    assert.ok(result.every(({ compatibility }) => compatibility === "declared" || compatibility === "same-minor"))
  })

  it("can resolve accepted candidates past the six-card display cap for local backfill", async () => {
    const catalog = Array.from({ length: MAX_SUGGESTIONS + 1 }, (_, index) => listing(index + 1, `Mod ${index + 1}`))
    const ranked = rankSuggestions({
      catalog,
      installation: installation("current"),
      otherInstallations: [],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })

    const result = await resolveSuggestions({
      candidates: ranked,
      targetGameVersion: "1.22.7",
      maxSuggestions: MAX_SUGGESTIONS + 1,
      getDetail: async (listingId) => compatibleDetail(catalog[listingId - 1]!)
    })

    assert.equal(result.length, MAX_SUGGESTIONS + 1)
    assert.deepEqual(
      result.map(({ mod }) => mod.modid),
      catalog.map(({ modid }) => modid)
    )
  })

  it("does not resolve a detail whose releases are undeclared for the target version", async () => {
    const candidate = listing(1, "Undeclared")
    const detail = compatibleDetail(candidate)
    const ranked = rankSuggestions({
      catalog: [candidate],
      installation: installation("current"),
      otherInstallations: [],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })

    const result = await resolveSuggestions({
      candidates: ranked,
      targetGameVersion: "1.22.7",
      getDetail: async () => ({ ...detail, releases: [{ ...detail.releases[0]!, tags: ["1.21.9"] }] })
    })

    assert.deepEqual(result, [])
  })

  it("does not publish work cancelled before a lookup or after a lookup completes", async () => {
    const candidate = rankSuggestions({
      catalog: [listing(1, "Mod")],
      installation: installation("current"),
      otherInstallations: [],
      dismissedListingIds: [],
      targetGameVersion: "1.22.7",
      now: NOW
    })
    const before = new AbortController()
    before.abort()
    let beforeCalls = 0
    assert.deepEqual(
      await resolveSuggestions({
        candidates: candidate,
        targetGameVersion: "1.22.7",
        signal: before.signal,
        getDetail: async () => {
          beforeCalls++
          return undefined
        }
      }),
      []
    )
    assert.equal(beforeCalls, 0)

    const after = new AbortController()
    let afterCalls = 0
    const result = await resolveSuggestions({
      candidates: candidate,
      targetGameVersion: "1.22.7",
      signal: after.signal,
      getDetail: async () => {
        afterCalls++
        after.abort()
        return compatibleDetail(listing(1, "Mod"))
      }
    })
    assert.deepEqual(result, [])
    assert.equal(afterCalls, 1)
  })
})
