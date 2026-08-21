import assert from "node:assert/strict"
import { describe, it, vi } from "vitest"

import type { IpcMainEvent } from "electron"

import { IconMemoryCache } from "@domain/mods/iconMemoryCache"
import { clearModIconMemoryCache, createClearModIconMemoryCacheHandler } from "@src/main/modIconMemoryCacheLifecycle"

function seededCache(): IconMemoryCache {
  const cache = new IconMemoryCache(100)
  cache.set("icon", Buffer.from("bytes"))
  return cache
}

describe("mod icon memory cache lifecycle", () => {
  it("clears the cache through the window-close fallback", () => {
    const cache = seededCache()

    clearModIconMemoryCache(cache)

    assert.equal(cache.size, 0)
    assert.equal(cache.bytes, 0)
  })

  it("clears the cache for a trusted renderer request", () => {
    const cache = seededCache()
    const event = {} as IpcMainEvent
    const isTrusted = vi.fn(() => true)

    createClearModIconMemoryCacheHandler(cache, isTrusted)(event)

    assert.deepEqual(isTrusted.mock.calls, [[event]])
    assert.equal(cache.size, 0)
  })

  it("does not clear the cache when the sender is rejected", () => {
    const cache = seededCache()
    const event = {} as IpcMainEvent
    const isTrusted = vi.fn(() => false)

    createClearModIconMemoryCacheHandler(cache, isTrusted)(event)
    assert.deepEqual(isTrusted.mock.calls, [[event]])
    assert.equal(cache.size, 1)
    assert.equal(cache.bytes, 5)
  })
})
