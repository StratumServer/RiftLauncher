import { useGetInstalledMods } from "./useGetInstalledMods"
import { useQueryMod } from "./useQueryMod"

import { findModUpdate } from "@domain/mods/compatibility"
import { logMods } from "@renderer/features/moddb/adapters/log"
import { cacheModImage } from "@renderer/features/moddb/adapters/modsManager"
import { installedModLookups, modDetailLookups } from "./modDetailLookups"

/** What one lookup learned about a ModDB entry. Not-found and failed lookups are results too. */
type ModLookupResult = { mod?: DownloadableModType; failed: boolean }

/**
 * What a full scan learned, keyed by mod id for the lookups and by URL for the logo step, misses
 * included. A scan handed one reads and fills it, so a rescan after a single-Mod action asks the
 * network only about ids the cache has never seen (#800).
 */
export type ModScanCache = { details: Map<string, ModLookupResult>; images: Map<string, string | undefined> }

export function newModScanCache(): ModScanCache {
  return { details: new Map(), images: new Map() }
}

/**
 * A big Mods folder queries the ModDB once per installed mod with nothing of its own capping how
 * many of those run at once (#386). Left unbounded, that fan-out could occupy every slot of the
 * shared QUERY_URL limiter (netHandlers.ts, 6), making a catalog search or filter change on
 * another page queue behind the whole scan instead of running immediately. 2 is well under that
 * shared cap, so a scan never takes more than a third of it and the rest of the app stays quick.
 */
export function useGetCompleteInstalledMods(): ({
  path,
  version,
  onFinish,
  cache
}: {
  path: string
  version: string
  onFinish?: (updates: number, failedLookups: number) => void
  cache?: ModScanCache
}) => Promise<{
  mods: InstalledModType[]
  errors: ErrorInstalledModType[]
}> {
  const getInstalledMods = useGetInstalledMods()
  const queryMod = useQueryMod()

  /**
   * Get the mods installed on the selected folder, query each mod from the moddb and add it to the mod, check if there is any update and add it to the mod.
   *
   * @param {Object} props
   * @param {string} [props.path] Path to look for mods.
   * @param {string} [props.version] Installation/Server version to check if there are compatible updates WITHOUT "v"! Example: ~~v1.2.3~~ 1.2.3
   * @param {(updates: number, failedLookups: number) => void} [props.onFinish] Function called before returning mods. Updates is the number of updates found, and failedLookups is the number of distinct mod ids whose lookups failed.
   * @param {ModScanCache} [props.cache] Answers from an earlier scan to reuse, and where this scan writes its own. Left out, every id is looked up.
   * @returns {Promise<{mods: InstalledModType[]errors: ErrorInstalledModType[]}>} Mods with ModDB mods and updates(if any) and mods with errors.
   */
  async function getCompleteInstalledMods({
    path,
    version,
    onFinish,
    cache = newModScanCache()
  }: {
    path: string
    version: string
    onFinish?: (updates: number, failedLookups: number) => void
    cache?: ModScanCache
  }): Promise<{
    mods: InstalledModType[]
    errors: ErrorInstalledModType[]
  }> {
    let availableModUpdates = 0

    const mods = await getInstalledMods({
      path: path,
      onFinish: () => logMods("info", `[front] [mods] [features/mods/hooks/useGetCompleteInstalledMods.ts] [useGetCompleteInstalledMods > getCompleteInstalledMods] Mods got succesfully.`)
    })

    // Two installed files can refer to the same ModDB entry. Keep one in-flight lookup per id
    // for this scan, while still evaluating every installed file against its own version.
    let lookupTimedOut = false
    const modDetails = new Map<string, Promise<ModLookupResult>>()
    const modImages = new Map<string, Promise<string | undefined>>()

    function queryModOnce(modid: number | string): Promise<ModLookupResult> {
      const key = String(modid)
      const pending = modDetails.get(key)
      if (pending) return pending

      const known = cache.details.get(key)
      if (known) {
        const reused = Promise.resolve(known)
        modDetails.set(key, reused)
        return reused
      }

      // Not-found means the mod is not known to ModDB, while lookup failure means the database
      // could not be reached or the request timed out. We track failed lookups separately so
      // callers know whether the update scan was complete.
      const request = installedModLookups.run(() =>
        modDetailLookups.run(async (): Promise<ModLookupResult> => {
          if (lookupTimedOut) return { failed: true }

          const outcome = await queryMod({ modid })
          if (outcome.status === "found") return { mod: outcome.mod, failed: false }
          if (outcome.status === "failed") {
            if (outcome.timedOut) lookupTimedOut = true
            return { failed: true }
          }
          return { failed: false }
        })
      )
      modDetails.set(key, request)
      void request.then((result) => cache.details.set(key, result))
      return request
    }

    function cacheModImageOnce(url: string): Promise<string | undefined> {
      const pending = modImages.get(url)
      if (pending) return pending

      if (cache.images.has(url)) return Promise.resolve(cache.images.get(url))

      // Swallowed like queryModOnce's sibling: one logo that fails to cache costs that row its
      // image, never the whole scan. cacheModImage already catches internally, but a rejected
      // invoke would otherwise reject the Promise.all below and leave the list stuck.
      const request = cacheModImage(url).catch(() => undefined)
      void request.then((image) => cache.images.set(url, image))
      modImages.set(url, request)
      return request
    }

    await Promise.all(
      mods.mods.map(async (mod) => {
        const result = await queryModOnce(mod.modid)
        const dmod = result.mod
        mod._mod = dmod

        if (!mod._image && dmod?.logofile) mod._image = await cacheModImageOnce(dmod.logofile)

        if (dmod) {
          const update = findModUpdate(mod.version, dmod.releases, version)
          if (update.updatableTo) {
            availableModUpdates++
            mod._updatableTo = update.updatableTo
          }
          if (update.lastVersion) mod._lastVersion = update.lastVersion
        }
      })
    )

    let failedLookups = 0
    for (const lookup of await Promise.all(Array.from(modDetails.values()))) {
      if (lookup.failed) failedLookups++
    }

    logMods("info", `[front] [mods] [features/mods/hooks/useGetCompleteInstalledMods.ts] [useGetCompleteInstalledMods > getCompleteInstalledMods] Found ${availableModUpdates} mod updates.`)

    if (onFinish) onFinish(availableModUpdates, failedLookups)
    return mods
  }

  return getCompleteInstalledMods
}
