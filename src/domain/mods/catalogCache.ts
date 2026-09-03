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
/**
 * How many bytes the mod catalog disk cache is allowed to keep. Enforced once per launch by
 * `pruneModCatalogCache`, not live: a long session with heavy filter churn can pass this budget
 * and stay past it until the next start.
 */
export const MOD_CATALOG_CACHE_MAX_BYTES = 64 * 1024 * 1024

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
 * Which cached catalog responses to delete when the folder exceeds its byte budget.
 *
 * The least recently written entries go first until the survivors fit `maxBytes`. Unlike the mod
 * icon cache, there is no "name this store could not have written" pass here: every name this
 * function is asked about is expected to already be a complete `<sha256-of-url>.json` entry. A
 * write-file-atomic temp leftover from an interrupted write (`<hash>.json.<pid>`) is
 * `orphanedTempFiles.ts`'s job, not this one's. Filtering those out before they ever reach this
 * function is the host's responsibility, so that an in-flight write is never mistaken for a stale
 * entry and removed out from under it.
 *
 * @param entries Every complete cache entry in the folder.
 * @param options.maxBytes Budget the survivors have to fit in.
 * @returns The names to remove, in deletion order.
 */
export function planModCatalogCacheEviction(entries: readonly CachedCatalogResponse[], options: { maxBytes?: number } = {}): string[] {
  const maxBytes = options.maxBytes ?? MOD_CATALOG_CACHE_MAX_BYTES

  let total = entries.reduce((bytes, entry) => bytes + entry.bytes, 0)
  if (total <= maxBytes) return []

  const evicted: string[] = []
  for (const entry of [...entries].sort((one, other) => one.modifiedAt - other.modifiedAt)) {
    if (total <= maxBytes) break
    evicted.push(entry.name)
    total -= entry.bytes
  }

  return evicted
}
