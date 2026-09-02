/**
 * How many bytes the disk cache for mods-catalog API responses (`src/ipc/catalogCache.ts`) is
 * allowed to keep.
 *
 * Each entry is already bounded to `MAX_MODS_CATALOG_RESPONSE_BYTES` (16 MiB, see
 * `src/ipc/validation.ts`) on write, but that caps one file, not the folder: one file per distinct
 * filter/search combination a player has ever used, and `ListMods.tsx` re-queries 400ms after any
 * filter change, so an idle install still accumulates one of these per session of browsing. 64 MiB
 * matches the mod icon cache's budget right next to it (`MOD_ICON_CACHE_MAX_BYTES` in
 * `iconCache.ts`) and holds on the order of a thousand realistic catalog responses, which run from a
 * few KB (a narrow search) to a few hundred KB (an unfiltered page), nowhere near the defensive
 * 16 MiB per-entry ceiling, which exists for a malformed or hostile response, not a typical one.
 */
export const MOD_CATALOG_CACHE_MAX_BYTES = 64 * 1024 * 1024

/**
 * How long a cached catalog response survives without being re-fetched, regardless of the byte cap.
 *
 * The cache exists to serve as a fallback body when a live fetch fails (network down, ceiling
 * tripped, non-2xx status), not as an archive: it self-heals the moment a player runs that exact
 * filter combination again. An entry nobody has re-fetched in a month is a combination the player has
 * likely stopped using, and serving mod data that stale as a "last good" fallback is a worse outcome
 * than the plain failure path it exists to avoid, so it is worth dropping even when the folder is
 * still under budget.
 */
export const MOD_CATALOG_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

/** One complete cache entry the host found in the mod-catalog cache folder. */
export interface CachedCatalogResponse {
  /** File name inside the cache folder, never a path. */
  name: string
  /** Size on disk. */
  bytes: number
  /** This entry's last successful write, in epoch milliseconds. */
  modifiedAt: number
}

/**
 * Which cached catalog responses to delete, in two passes.
 *
 * Every entry older than `maxAgeMs` goes first and unconditionally, whether or not the folder is
 * over budget: no fetch failure should be served mod data nobody has confirmed still matches the
 * catalog in that long. If the survivors still do not fit `maxBytes`, the least recently written go
 * until they do.
 *
 * Unlike the mod icon cache, there is no "name this store could not have written" pass here: every
 * name this function is asked about is expected to already be a complete `<sha256-of-url>.json`
 * entry. A write-file-atomic temp leftover from an interrupted write (`<hash>.json.<pid>`) is
 * `orphanedTempFiles.ts`'s job, not this one's. Filtering those out before they ever reach this
 * function is the host's responsibility, so that an in-flight write is never mistaken for a stale
 * entry and removed out from under it.
 *
 * @param entries Every complete cache entry in the folder.
 * @param options.maxBytes Budget the survivors have to fit in.
 * @param options.maxAgeMs How long an entry survives without being re-fetched.
 * @param options.nowMs Injectable clock for deterministic tests.
 * @returns The names to remove, in deletion order.
 */
export function planModCatalogCacheEviction(entries: readonly CachedCatalogResponse[], options: { maxBytes?: number; maxAgeMs?: number; nowMs?: number } = {}): string[] {
  const maxBytes = options.maxBytes ?? MOD_CATALOG_CACHE_MAX_BYTES
  const maxAgeMs = options.maxAgeMs ?? MOD_CATALOG_CACHE_MAX_AGE_MS
  const nowMs = options.nowMs ?? Date.now()

  const evicted: string[] = []
  const survivors: CachedCatalogResponse[] = []

  for (const entry of entries) {
    if (nowMs - entry.modifiedAt > maxAgeMs) evicted.push(entry.name)
    else survivors.push(entry)
  }

  let total = survivors.reduce((bytes, entry) => bytes + entry.bytes, 0)
  if (total <= maxBytes) return evicted

  for (const entry of [...survivors].sort((one, other) => one.modifiedAt - other.modifiedAt)) {
    if (total <= maxBytes) break
    evicted.push(entry.name)
    total -= entry.bytes
  }

  return evicted
}
