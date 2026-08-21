/**
 * How many bytes of decoded mod icon data the running process is allowed to hold in
 * memory at once.
 *
 * A quarter of the on-disk budget (see MOD_ICON_CACHE_MAX_BYTES in iconCache.ts): the
 * grid only ever needs the icons currently on screen plus whatever scroll just brought
 * into view, never the whole shared folder at once.
 */
export const MOD_ICON_MEMORY_CACHE_MAX_BYTES = 16 * 1024 * 1024

/**
 * Bounded, recency-ordered cache for content-addressed mod icon bytes.
 *
 * Filenames the icon store writes are the sha256 of their own bytes (iconCache.ts), so a
 * hit under a given key can never be stale: nothing can rewrite a name's content without
 * changing the name. That leaves eviction as the only thing this has to get right, not
 * invalidation, which is what keeps `get`/`set` this small.
 */
export class IconMemoryCache {
  private readonly entries = new Map<string, Buffer>()
  private totalBytes = 0
  private clearGeneration = 0

  constructor(private readonly maxBytes: number = MOD_ICON_MEMORY_CACHE_MAX_BYTES) {}

  get(key: string): Buffer | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined

    // Re-inserting moves the key to the end of Map's insertion-ordered iteration,
    // which is what makes the first entries visited below the least recently used.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, bytes: Buffer): void {
    this.remove(key)

    // A single icon larger than the whole budget must not remain in the cache by
    // itself, and replacing an existing key with one must not retain the old entry.
    if (bytes.length > this.maxBytes) return

    this.entries.set(key, bytes)
    this.totalBytes += bytes.length

    for (const [oldestKey, oldestBytes] of this.entries) {
      if (this.totalBytes <= this.maxBytes) break
      if (oldestKey === key) continue
      this.entries.delete(oldestKey)
      this.totalBytes -= oldestBytes.length
    }
  }

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.totalBytes
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
    this.clearGeneration += 1
  }

  get generation(): number {
    return this.clearGeneration
  }

  private remove(key: string): void {
    const existing = this.entries.get(key)
    if (!existing) return

    this.entries.delete(key)
    this.totalBytes -= existing.length
  }
}

/**
 * Returns `key`'s bytes from `cache`, calling `readBytes` (the actual disk read) only on a
 * miss. Takes the read as a callback instead of a file path so the caller decides what
 * "reading" means (net.fetch in production, a counted stub in a test) without this
 * function knowing anything about Electron or the file system.
 */
export async function readIconWithMemoryCache(cache: IconMemoryCache, key: string, readBytes: () => Promise<Buffer>): Promise<Buffer> {
  const cached = cache.get(key)
  if (cached) return cached

  const generation = cache.generation
  const bytes = await readBytes()
  if (cache.generation === generation) cache.set(key, bytes)
  return bytes
}
