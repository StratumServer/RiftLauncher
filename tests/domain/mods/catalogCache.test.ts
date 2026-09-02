import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { MOD_CATALOG_CACHE_MAX_AGE_MS, MOD_CATALOG_CACHE_MAX_BYTES, planModCatalogCacheEviction } from "../../../src/domain/mods/catalogCache"
import type { CachedCatalogResponse } from "../../../src/domain/mods/catalogCache"

const NOW = 1_000_000_000_000

function entry(name: string, bytes: number, modifiedAt: number): CachedCatalogResponse {
  return { name, bytes, modifiedAt }
}

describe("planModCatalogCacheEviction", () => {
  it("has nothing to say about an empty folder", () => {
    assert.deepEqual(planModCatalogCacheEviction([]), [])
  })

  it("keeps every entry that fits the budget and is within the TTL", () => {
    const entries = [entry("a.json", 1_000, NOW), entry("b.json", 2_000, NOW - 1_000)]

    assert.deepEqual(planModCatalogCacheEviction(entries, { maxBytes: 64 * 1024, nowMs: NOW }), [])
  })

  it("evicts an entry past the TTL unconditionally, even while the folder is under budget", () => {
    const stale = entry("stale.json", 10, NOW - MOD_CATALOG_CACHE_MAX_AGE_MS - 1)
    const fresh = entry("fresh.json", 10, NOW)

    assert.deepEqual(planModCatalogCacheEviction([stale, fresh], { nowMs: NOW }), ["stale.json"])
  })

  it("keeps an entry exactly at the TTL boundary", () => {
    const entries = [entry("boundary.json", 10, NOW - MOD_CATALOG_CACHE_MAX_AGE_MS)]

    assert.deepEqual(planModCatalogCacheEviction(entries, { nowMs: NOW }), [])
  })

  it("drops the least recently written entries first once the folder is over budget", () => {
    const entries = [entry("a.json", 40, NOW - 300), entry("b.json", 40, NOW - 100), entry("c.json", 40, NOW - 200)]

    assert.deepEqual(planModCatalogCacheEviction(entries, { maxBytes: 100, nowMs: NOW }), ["a.json"])
  })

  it("stops evicting as soon as the survivors fit", () => {
    const entries = [entry("a.json", 30, NOW - 400), entry("b.json", 30, NOW - 100), entry("c.json", 30, NOW - 200), entry("d.json", 30, NOW - 300)]

    assert.deepEqual(planModCatalogCacheEviction(entries, { maxBytes: 60, nowMs: NOW }), ["a.json", "d.json"])
  })

  it("counts only TTL survivors against the byte budget", () => {
    // The stale entry is going anyway (TTL), so its bytes must not push a folder that fits
    // without it into evicting a fresh entry too.
    const stale = entry("stale.json", 80, NOW - MOD_CATALOG_CACHE_MAX_AGE_MS - 1)
    const fresh = entry("fresh.json", 40, NOW)

    assert.deepEqual(planModCatalogCacheEviction([stale, fresh], { maxBytes: 60, nowMs: NOW }), ["stale.json"])
  })

  it("defaults to the exported budget and TTL constants", () => {
    const overBudget = entry("big.json", MOD_CATALOG_CACHE_MAX_BYTES + 1, NOW)
    assert.deepEqual(planModCatalogCacheEviction([overBudget], { nowMs: NOW }), ["big.json"])

    const overAge = entry("old.json", 10, NOW - MOD_CATALOG_CACHE_MAX_AGE_MS - 1)
    assert.deepEqual(planModCatalogCacheEviction([overAge], { nowMs: NOW }), ["old.json"])
  })
})
