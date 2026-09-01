import { createHash } from "node:crypto"
import { app } from "electron"
import fse from "fs-extra"
import { join } from "node:path"

import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"
import { isRecord, MAX_MODS_CATALOG_RESPONSE_BYTES } from "@src/ipc/validation"

// Disk cache for the mods-catalog API response, used to serve the last good body when a
// fresh fetch fails (network down, ceiling tripped, non-2xx status). One file per cached
// URL, keyed by a hash of the URL so distinct filter/search queries do not collide.
// No TTL: the cache self-heals on the next successful fetch of the same URL.

const CACHE_STORE_VERSION = 1

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
