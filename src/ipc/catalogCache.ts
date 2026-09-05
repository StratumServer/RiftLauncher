import { createHash } from "node:crypto"
import { app } from "electron"
import fse from "fs-extra"
import { join } from "node:path"

import { MOD_CATALOG_CACHE_MAX_BYTES, planModCatalogCacheEviction } from "@domain/mods/catalogCache"
import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"
import { sweepCacheFolder } from "@src/ipc/cacheSweep"
import { isRecord, MAX_MODS_CATALOG_RESPONSE_BYTES } from "@src/ipc/validation"

// Disk cache for the mods-catalog API response, used to serve the last good body when a
// fresh fetch fails (network down, ceiling tripped, non-2xx status). One file per cached
// URL, keyed by a hash of the URL so distinct filter/search queries do not collide. The
// cache self-heals on the next successful fetch of the same URL, and pruneModCatalogCache
// below sweeps least recently written entries once the folder passes its byte cap. Age
// alone evicts nothing: an old body is exactly what the offline fallback has to serve.

const CACHE_STORE_VERSION = 1

/** Names this store writes: the sha256 of the cached URL, lower case, with a `.json` suffix. */
const CONTENT_ADDRESSED_NAME = /^[0-9a-f]{64}\.json$/

type CatalogCacheEntry = {
  version: 1
  url: string
  body: string
}

function isCatalogCacheEntry(value: unknown): value is CatalogCacheEntry {
  return isRecord(value) && value["version"] === CACHE_STORE_VERSION && typeof value["url"] === "string" && typeof value["body"] === "string"
}

function getCacheDirectory(): string {
  return join(app.getPath("userData"), "Cache", "ModCatalog")
}

function getCacheFilePath(url: URL): string {
  const key = createHash("sha256").update(url.toString()).digest("hex")
  return join(getCacheDirectory(), `${key}.json`)
}

/**
 * Reads the last good cached response body for this URL, if any. Returns null on a cache
 * miss and also degrades to null (rather than throwing) when the cache file is missing,
 * unreadable, or corrupt, so callers can fall back to the plain failure path.
 */
export async function readCatalogCache(url: URL): Promise<string | null> {
  try {
    const stored: unknown = await fse.readJSON(getCacheFilePath(url))
    if (!isCatalogCacheEntry(stored) || stored.url !== url.toString()) return null
    return stored.body
  } catch {
    return null
  }
}

/**
 * Write-through cache: stores the response body for this URL on disk, overwriting any
 * previous entry for the same URL. Bounded to the catalog response ceiling as a defensive
 * measure even though callers only cache already-bounded successful responses.
 */
export async function writeCatalogCache(url: URL, body: string): Promise<void> {
  if (Buffer.byteLength(body, "utf8") > MAX_MODS_CATALOG_RESPONSE_BYTES) return

  const cacheDirectory = getCacheDirectory()
  const filePath = getCacheFilePath(url)
  const entry: CatalogCacheEntry = { version: CACHE_STORE_VERSION, url: url.toString(), body }

  await fse.ensureDir(cacheDirectory)
  await writeJsonAtomic(filePath, entry)
}

/**
 * Deletes the least recently written survivors once the folder is over
 * {@link MOD_CATALOG_CACHE_MAX_BYTES}. See `planModCatalogCacheEviction` in
 * `@domain/mods/catalogCache` for the eviction order itself, and `sweepCacheFolder` in
 * `@src/ipc/cacheSweep` for the walk that drives it; this function only says what tells this cache
 * apart from the mod icon one.
 *
 * Only files matching `CONTENT_ADDRESSED_NAME` are ever considered. write-file-atomic leaves a
 * `<hash>.json.<pid>` sibling behind while a write is in flight, which becomes a crash leftover if
 * the process dies before the rename. Cleaning those up is `orphanedTempFiles.ts`'s job (it already
 * sweeps this same directory for `atomic-json` temp files, age-gated at a week), not this function's:
 * it has no way to tell an in-flight write apart from garbage, so it must never touch either. Re-
 * stating a file immediately before removing it guards a related race: if a concurrent successful
 * fetch just rewrote an entry this sweep already decided to evict, its mtime will have moved and the
 * removal is skipped.
 *
 * Fire-and-forget and best effort throughout, same as `pruneModIconCache` it now shares its walk
 * with: this runs once at startup, after the window exists, off the first-paint path, and a cache
 * sweep must never be able to break a launch, so every filesystem error is logged and swallowed.
 *
 * @param maxBytes Budget the survivors have to fit in. Only tests pass this.
 */
export async function pruneModCatalogCache(maxBytes: number = MOD_CATALOG_CACHE_MAX_BYTES): Promise<void> {
  await sweepCacheFolder({
    folder: getCacheDirectory(),
    origin: "[back] [ipc] [ipc/catalogCache.ts] [pruneModCatalogCache]",
    subject: "the mod catalog cache",
    accepts: (name) => CONTENT_ADDRESSED_NAME.test(name),
    recencyOf: (stats) => stats.mtimeMs,
    plan: (entries) =>
      planModCatalogCacheEviction(
        entries.map(({ name, bytes, recencyMs }) => ({ name, bytes, modifiedAt: recencyMs })),
        { maxBytes }
      )
  })
}
