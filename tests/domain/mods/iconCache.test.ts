import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { MOD_ICON_CACHE_MAX_BYTES, planIconCacheEviction } from "../../../src/domain/mods/iconCache"
import type { CachedIcon } from "../../../src/domain/mods/iconCache"

/** A content-addressed name of the shape the store writes, seeded from one character. */
function contentName(seed: string): string {
  return `${seed.repeat(64).slice(0, 64)}.png`
}

function icon(name: string, bytes: number, modifiedAt: number): CachedIcon {
  return { name, bytes, modifiedAt }
}

describe("planIconCacheEviction", () => {
  it("has nothing to say about an empty folder", () => {
    assert.deepEqual(planIconCacheEviction([]), [])
  })

  it("keeps every content-named icon that fits the budget", () => {
    const entries = [icon(contentName("a"), 1_000, 1), icon(contentName("b"), 2_000, 2)]

    assert.deepEqual(planIconCacheEviction(entries, 64 * 1024), [])
  })

  it("evicts a name the current store could not have written, whatever the budget", () => {
    // uuid-named files are what the build before content addressing left behind:
    // nothing points at them and no write can produce one again.
    const entries = [icon("2f8a6d3c-7b1e-4a55-9d20-0c5f4e6b8a91.png", 10, 1), icon(contentName("c"), 10, 2)]

    assert.deepEqual(planIconCacheEviction(entries, MOD_ICON_CACHE_MAX_BYTES), ["2f8a6d3c-7b1e-4a55-9d20-0c5f4e6b8a91.png"])
  })

  it("reads a name as one the store could have written only in the exact shape", () => {
    const evicted = [icon(`${"A".repeat(64)}.png`, 10, 1), icon(`${"a".repeat(63)}.png`, 10, 2), icon(`${"a".repeat(64)}.png.tmp`, 10, 4), icon(`${"a".repeat(64)}.gif`, 10, 5)]
    const kept = [icon(`${"a".repeat(64)}.jpg`, 10, 6), icon(`${"b".repeat(64)}.jpeg`, 10, 7)]

    assert.deepEqual(
      planIconCacheEviction([...evicted, ...kept]),
      evicted.map((entry) => entry.name)
    )
  })

  it("keeps a ModDB logo named after its URL, whatever the format", () => {
    const entries = [icon(contentName("a"), 10, 1), icon(`${"c".repeat(64)}.jpg`, 20, 2)]

    assert.deepEqual(planIconCacheEviction(entries, MOD_ICON_CACHE_MAX_BYTES), [])
  })

  it("drops the oldest content-named icons first once the folder is over budget", () => {
    const entries = [icon(contentName("a"), 40, 300), icon(contentName("b"), 40, 100), icon(contentName("c"), 40, 200)]

    assert.deepEqual(planIconCacheEviction(entries, 100), [contentName("b")])
  })

  it("stops evicting as soon as the survivors fit", () => {
    const entries = [icon(contentName("a"), 30, 400), icon(contentName("b"), 30, 100), icon(contentName("c"), 30, 200), icon(contentName("d"), 30, 300)]

    assert.deepEqual(planIconCacheEviction(entries, 60), [contentName("b"), contentName("c")])
  })

  it("counts only the survivors against the budget", () => {
    // The legacy file is going anyway, so its bytes must not push a folder that
    // fits without it into evicting a live icon too.
    const entries = [icon("legacy.png", 80, 1), icon(contentName("a"), 40, 2)]

    assert.deepEqual(planIconCacheEviction(entries, 60), ["legacy.png"])
  })
})
