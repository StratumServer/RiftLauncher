import { useCallback } from "react"

import { parseModDetailResponse } from "@domain/mods/moddb"
import { queryModDb } from "@renderer/features/moddb/adapters/moddb"
import { logMods } from "@renderer/features/moddb/adapters/log"

export function useQueryMod(): ({ modid, onFinish }: { modid: number | string; onFinish?: () => void }) => Promise<DownloadableModType | undefined> {
  /**
   * Makes a query and returns the mod with the passed Mod ID.
   *
   * The callback closes over nothing but module imports, so it is memoized with an empty
   * dependency list: a caller that queries from an effect can then depend on it honestly
   * instead of leaving it out of the dependency array to avoid a re-query on every render.
   *
   * @param {object} props
   * @param {string} [props.modid] Mod ID string to query it.
   * @param {() => void} [props.onFinish] Optional function that will be called just before returning the mod.
   * @returns {Promise<void>}
   */
  return useCallback(async function queryMod({ modid, onFinish }: { modid: number | string; onFinish?: () => void }): Promise<DownloadableModType | undefined> {
    try {
      const res = await queryModDb(`/mod/${modid}`)
      const parsed = parseModDetailResponse(res)

      if (onFinish) onFinish()

      if (!parsed.ok) return

      return parsed.payload as unknown as DownloadableModType
    } catch (err) {
      logMods("error", `[front] [mods] [features/mods/hooks/useQueryMod.ts] [useQueryMod > queryMod] Error fetching ${modid} mod versions.`)
      logMods("debug", `[front] [mods] [features/mods/hooks/useQueryMod.ts] [useQueryMod > queryMod] Error fetching ${modid} mod versions: ${err}`)
      return
    }
  }, [])
}
