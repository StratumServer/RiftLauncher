import assert from "node:assert/strict"
import { describe, it, vi } from "vitest"

import { IconMemoryCache, readIconWithMemoryCache } from "../../../src/domain/mods/iconMemoryCache"

describe("IconMemoryCache", () => {
  it("misses on a key it has never seen", () => {
    const cache = new IconMemoryCache(1_000)
    assert.equal(cache.get("a"), undefined)
  })

  it("returns exactly the bytes it was given", () => {
    const cache = new IconMemoryCache(1_000)
    const bytes = Buffer.from("hello")
    cache.set("a", bytes)
    assert.deepEqual(cache.get("a"), bytes)
  })

  it("stays under budget by evicting the least recently used entry", () => {
    const cache = new IconMemoryCache(10)
    cache.set("a", Buffer.alloc(5))
    cache.set("b", Buffer.alloc(5))
    // Over budget (10 bytes already held): evicts "a", the oldest, to make room.
    cache.set("c", Buffer.alloc(5))

    assert.equal(cache.get("a"), undefined)
    assert.notEqual(cache.get("b"), undefined)
    assert.notEqual(cache.get("c"), undefined)
    assert.equal(cache.bytes, 10)
    assert.equal(cache.size, 2)
  })

  it("touching an entry protects it from the next eviction", () => {
    const cache = new IconMemoryCache(10)
    cache.set("a", Buffer.alloc(5))
    cache.set("b", Buffer.alloc(5))

    // "a" is now the most recently used of the two.
    cache.get("a")

    cache.set("c", Buffer.alloc(5))

    assert.notEqual(cache.get("a"), undefined)
    assert.equal(cache.get("b"), undefined)
    assert.notEqual(cache.get("c"), undefined)
  })

  it("replacing a key accounts for the old bytes leaving before the new ones land", () => {
    const cache = new IconMemoryCache(10)
    cache.set("a", Buffer.alloc(5))
    cache.set("a", Buffer.alloc(8))

    assert.equal(cache.bytes, 8)
    assert.equal(cache.size, 1)
  })

  it("does not retain an icon larger than the whole budget", () => {
    const cache = new IconMemoryCache(10)
    cache.set("a", Buffer.alloc(11))

    assert.equal(cache.size, 0)
    assert.equal(cache.bytes, 0)
  })

  it("removes an existing icon when its replacement is too large", () => {
    const cache = new IconMemoryCache(10)
    cache.set("a", Buffer.alloc(5))
    cache.set("a", Buffer.alloc(11))

    assert.equal(cache.get("a"), undefined)
    assert.equal(cache.size, 0)
    assert.equal(cache.bytes, 0)
  })

  it("clear empties the cache", () => {
    const cache = new IconMemoryCache(10)
    cache.set("a", Buffer.alloc(5))
    cache.clear()

    assert.equal(cache.size, 0)
    assert.equal(cache.bytes, 0)
    assert.equal(cache.get("a"), undefined)
  })
})

describe("readIconWithMemoryCache", () => {
  it("reads from disk once and serves every later request for the same icon from memory", async () => {
    const cache = new IconMemoryCache(1_000)
    const readBytes = vi.fn(async () => Buffer.from("icon bytes"))

    const first = await readIconWithMemoryCache(cache, "/cache/aa.png", readBytes)
    const second = await readIconWithMemoryCache(cache, "/cache/aa.png", readBytes)
    const third = await readIconWithMemoryCache(cache, "/cache/aa.png", readBytes)

    assert.equal(readBytes.mock.calls.length, 1)
    assert.deepEqual(first, Buffer.from("icon bytes"))
    assert.deepEqual(second, Buffer.from("icon bytes"))
    assert.deepEqual(third, Buffer.from("icon bytes"))
  })

  it("still reads from disk once per distinct icon", async () => {
    const cache = new IconMemoryCache(1_000)
    const readBytes = vi.fn(async () => Buffer.from("icon bytes"))

    await readIconWithMemoryCache(cache, "/cache/aa.png", readBytes)
    await readIconWithMemoryCache(cache, "/cache/bb.png", readBytes)
    await readIconWithMemoryCache(cache, "/cache/cc.png", readBytes)

    assert.equal(readBytes.mock.calls.length, 3)
  })

  it("does not repopulate the cache after it is cleared during an in-flight read", async () => {
    const cache = new IconMemoryCache(1_000)
    let finishRead!: (bytes: Buffer) => void
    const readBytes = vi.fn(
      () =>
        new Promise<Buffer>((resolve) => {
          finishRead = resolve
        })
    )

    const pending = readIconWithMemoryCache(cache, "/cache/aa.png", readBytes)
    cache.clear()
    finishRead(Buffer.from("icon bytes"))

    assert.deepEqual(await pending, Buffer.from("icon bytes"))
    assert.equal(cache.get("/cache/aa.png"), undefined)
    assert.equal(cache.size, 0)
  })

  it("repopulates the cache after clear and serves later requests from memory", async () => {
    const cache = new IconMemoryCache(1_000)
    const readBytes = vi.fn(async () => Buffer.from("icon bytes"))

    await readIconWithMemoryCache(cache, "/cache/aa.png", readBytes)
    cache.clear()
    await readIconWithMemoryCache(cache, "/cache/aa.png", readBytes)
    await readIconWithMemoryCache(cache, "/cache/aa.png", readBytes)

    assert.equal(readBytes.mock.calls.length, 2)
    assert.deepEqual(cache.get("/cache/aa.png"), Buffer.from("icon bytes"))
  })
})
