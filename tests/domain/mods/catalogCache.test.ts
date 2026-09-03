import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { MOD_CATALOG_CACHE_MAX_BYTES, planModCatalogCacheEviction } from "../../../src/domain/mods/catalogCache"
import type { CachedCatalogResponse } from "../../../src/domain/mods/catalogCache"

const NOW = 1_000_000_000_000

function entry(name: string, bytes: number, modifiedAt: number): CachedCatalogResponse {
  return { name, bytes, modifiedAt }
}

describe("planModCatalogCacheEviction", () => {
  it("has nothing to say about an empty folder", () => {
    assert.deepEqual(planModCatalogCacheEviction([]), [])
  })

  it("keeps every entry that fits the budget", () => {
    const entries = [entry("a.json", 1_000, NOW), entry("b.json", 2_000, NOW - 1_000)]

    assert.deepEqual(planModCatalogCacheEviction(entries, { maxBytes: 64 * 1024 }), [])
  })

  it("drops the least recently written entries first once the folder is over budget", () => {
    const entries = [entry("a.json", 40, NOW - 300), entry("b.json", 40, NOW - 100), entry("c.json", 40, NOW - 200)]

    assert.deepEqual(planModCatalogCacheEviction(entries, { maxBytes: 100 }), ["a.json"])
  })

  it("stops evicting as soon as the survivors fit", () => {
    const entries = [entry("a.json", 30, NOW - 400), entry("b.json", 30, NOW - 100), entry("c.json", 30, NOW - 200), entry("d.json", 30, NOW - 300)]

    assert.deepEqual(planModCatalogCacheEviction(entries, { maxBytes: 60 }), ["a.json", "d.json"])
  })

  it("keeps old entries when the folder is under budget", () => {
    // Under the byte cap, an entry that has not been re-fetched in months still
    // costs nothing to keep and buys offline resilience.
    const old = entry("old.json", 10, NOW - 365 * 24 * 60 * 60 * 1_000)
    const recent = entry("recent.json", 10, NOW)

    assert.deepEqual(planModCatalogCacheEviction([old, recent], { maxBytes: 64 * 1024 }), [])
  })

  it("defaults to the exported budget constant", () => {
    const overBudget = entry("big.json", MOD_CATALOG_CACHE_MAX_BYTES + 1, NOW)
    assert.deepEqual(planModCatalogCacheEviction([overBudget]), ["big.json"])
  })
})
