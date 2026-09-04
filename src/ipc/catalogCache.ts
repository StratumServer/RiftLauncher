import { createHash } from "node:crypto"
import { app } from "electron"
import fse from "fs-extra"
import { join } from "node:path"

import type { CachedCatalogResponse } from "@domain/mods/catalogCache"
import { MOD_CATALOG_CACHE_MAX_BYTES, planModCatalogCacheEviction } from "@domain/mods/catalogCache"
import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"
import { isRecord, MAX_MODS_CATALOG_RESPONSE_BYTES } from "@src/ipc/validation"
import { logMessage } from "@src/utils/logManager"

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
 * `@domain/mods/catalogCache` for the eviction order itself; this function only walks the folder and
 * drives that decision.
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
 * Fire-and-forget and best effort throughout, same as `pruneModIconCache` next to it: this runs once
 * at startup, after the window exists, off the first-paint path, and a cache sweep must never be able
 * to break a launch, so every filesystem error is logged and swallowed.
 *
 * @param maxBytes Budget the survivors have to fit in. Only tests pass this.
 */
export async function pruneModCatalogCache(maxBytes: number = MOD_CATALOG_CACHE_MAX_BYTES): Promise<void> {
  const cacheDirectory = getCacheDirectory()

  let names: string[]
  try {
    names = await fse.readdir(cacheDirectory)
  } catch {
    // No cache folder yet, or it just vanished: nothing to sweep either way.
    return
  }

  const entries: CachedCatalogResponse[] = []
  for (const name of names) {
    if (!CONTENT_ADDRESSED_NAME.test(name)) continue
    try {
      const stats = await fse.stat(join(cacheDirectory, name))
      if (stats.isFile()) entries.push({ name, bytes: stats.size, modifiedAt: stats.mtimeMs })
    } catch (err) {
      logMessage("debug", `[back] [ipc] [ipc/catalogCache.ts] [pruneModCatalogCache] Skipping ${name}: ${err}`)
    }
  }

  const doomed = planModCatalogCacheEviction(entries, { maxBytes })
  if (doomed.length === 0) return

  const mtimeByName = new Map(entries.map((entry) => [entry.name, entry.modifiedAt]))
  const bytesByName = new Map(entries.map((entry) => [entry.name, entry.bytes]))
  let reclaimed = 0

  await Promise.all(
    doomed.map(async (name) => {
      try {
        // Re-stat before removal: if mtime moved since the snapshot, a concurrent
        // successful fetch just rewrote this entry. Skip it.
        const current = await fse.stat(join(cacheDirectory, name))
        if (current.mtimeMs !== mtimeByName.get(name)) return

        await fse.remove(join(cacheDirectory, name))
        reclaimed += bytesByName.get(name) ?? 0
      } catch (err) {
        logMessage("debug", `[back] [ipc] [ipc/catalogCache.ts] [pruneModCatalogCache] Could not remove ${name} from the mod catalog cache: ${err}`)
      }
    })
  )

  logMessage("info", `[back] [ipc] [ipc/catalogCache.ts] [pruneModCatalogCache] Removed ${doomed.length} entries from the mod catalog cache, ${reclaimed} bytes reclaimed.`)
}
