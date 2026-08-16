import { parseModDetailResponse } from "@domain/mods/moddb"
import { queryModDb } from "@renderer/features/moddb/adapters/moddb"
import { logMods } from "@renderer/features/moddb/adapters/log"

export function useQueryMod(): ({ modid, onFinish }: { modid: number | string; onFinish?: () => void }) => Promise<DownloadableModType | undefined> {
  /**
   * Makes a query and returns the mod with the passed Mod ID.
   *
   * @param {object} props
   * @param {string} [props.modid] Mod ID string to query it.
   * @param {() => void} [props.onFinish] Optional function that will be called just before returning the mod.
   * @returns {Promise<void>}
   */
  async function queryMod({ modid, onFinish }: { modid: number | string; onFinish?: () => void }): Promise<DownloadableModType | undefined> {
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
  }

  return queryMod
}
