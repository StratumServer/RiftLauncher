import { useCallback } from "react"

import { parseModDetailResponse } from "@domain/mods/moddb"
import { queryModDb } from "@renderer/features/moddb/adapters/moddb"
import { logMods } from "@renderer/features/moddb/adapters/log"

/**
 * What a mod detail lookup came back with.
 *
 * "not-found" and "failed" both leave the caller with no mod, but they are not the same thing: a
 * clean 404 means the ModDB has spoken and the id is not on it, while "failed" means the lookup
 * never got an answer at all (a thrown network error, a timeout, or a response that did not parse
 * as a v1 envelope). A caller that folds the two together ends up telling the player a mod is a
 * fork or a private build when the real story is that the database could not be reached.
 */
export type QueryModOutcome = { status: "found"; mod: DownloadableModType } | { status: "not-found" } | { status: "failed" }

export function useQueryMod(): ({ modid, onFinish }: { modid: number | string; onFinish?: () => void }) => Promise<QueryModOutcome> {
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
   * @returns {Promise<QueryModOutcome>}
   */
  return useCallback(async function queryMod({ modid, onFinish }: { modid: number | string; onFinish?: () => void }): Promise<QueryModOutcome> {
    try {
      const res = await queryModDb(`/mod/${modid}`)
      const parsed = parseModDetailResponse(res)

      if (onFinish) onFinish()

      // Only a genuine 404 counts as "not found". Every other way the envelope can fail to check
      // out, an unrecognised statuscode or a payload that does not parse, is not an answer this
      // caller can trust either way, so it is reported the same as a lookup that never came back.
      if (!parsed.ok) return parsed.reason === "api-error" && parsed.statusCode === "404" ? { status: "not-found" } : { status: "failed" }

      return { status: "found", mod: parsed.payload as unknown as DownloadableModType }
    } catch (err) {
      logMods("error", `[front] [mods] [features/mods/hooks/useQueryMod.ts] [useQueryMod > queryMod] Error fetching ${modid} mod versions.`)
      logMods("debug", `[front] [mods] [features/mods/hooks/useQueryMod.ts] [useQueryMod > queryMod] Error fetching ${modid} mod versions: ${err}`)
      return { status: "failed" }
    }
  }, [])
}
