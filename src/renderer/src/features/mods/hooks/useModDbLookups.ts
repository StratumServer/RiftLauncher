import { useEffect, useState } from "react"

import { parseAuthorsResponse, parseGameVersionsResponse, parseTagsResponse } from "@domain/mods/moddb"
import type { ModDbNamedEntry, ModDbResponse } from "@domain/mods/moddb"
import { queryModDb } from "@renderer/features/moddb/adapters/moddb"
import { logMods } from "@renderer/features/moddb/adapters/log"

/** One lookup list, plus whether the fetch that should have filled it failed. */
export interface ModDbLookup<Entry> {
  /** Everything the lookup returned. Empty until it lands, and after a failure. */
  entries: Entry[]
  /**
   * True once the lookup has given up. An empty list on its own says nothing to the player:
   * "the mod database has no authors" and "the request timed out" looked identical, which is
   * what #411 reported (the request rejects, nothing reaches the filter, the box stays empty).
   */
  failed: boolean
}

/**
 * Fetches one of the three ModDB lookup lists (authors, game versions, tags) once on mount.
 *
 * AuthorFilter, VersionsFilter and TagsFilter each used to run this exact fetch-parse-setState
 * dance themselves; factoring it out here is what lets them stay pure renderers over the list.
 */
function useModDbNamedListLookup(
  path: string,
  parse: (raw: string) => ModDbResponse<ModDbNamedEntry[]>,
  tag: string,
  transform: (list: ModDbNamedEntry[]) => ModDbNamedEntry[] = (list) => list
): ModDbLookup<ModDbNamedEntry> {
  const [entries, setEntries] = useState<ModDbNamedEntry[]>([])
  const [failed, setFailed] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false

    ;(async (): Promise<void> => {
      try {
        const res = await queryModDb(path)
        const parsed = parse(res)

        if (!parsed.ok) {
          logMods("warn", `[front] [mods] [features/mods/hooks/useModDbLookups.ts] [${tag} > queryModDb] Lookup failed: ${parsed.reason}.`)
          if (!cancelled) setFailed(true)
          return
        }

        if (!cancelled) setEntries(transform(parsed.payload))
      } catch {
        // A fixed line and one reason token, never the rejection's own text: it carries the URL
        // it was given. The concrete cause (a timeout, a refused connection) is already on the
        // other side of the bridge, where the QUERY_URL handler logs it at debug before it
        // rejects (src/ipc/handlers/netHandlers.ts).
        logMods("warn", `[front] [mods] [features/mods/hooks/useModDbLookups.ts] [${tag} > queryModDb] Lookup failed: request-failed.`)
        if (!cancelled) setFailed(true)
      }
    })()

    return (): void => {
      cancelled = true
    }
  }, [])

  return { entries, failed }
}

export function useAuthorsLookup(): ModDbLookup<DownloadableModAuthorType> {
  return useModDbNamedListLookup("/authors", parseAuthorsResponse, "AuthorFilter") as unknown as ModDbLookup<DownloadableModAuthorType>
}

/** Reversed to match the ModDB's newest-first listing, same as the pre-refactor VersionsFilter did. */
export function useGameVersionsLookup(): ModDbLookup<DownloadableModGameVersionType> {
  return useModDbNamedListLookup("/gameversions", parseGameVersionsResponse, "VersionsFilter", (list) => [...list].reverse()) as unknown as ModDbLookup<DownloadableModGameVersionType>
}

export function useTagsLookup(): ModDbLookup<DownloadableModTagType> {
  return useModDbNamedListLookup("/tags", parseTagsResponse, "TagsFilter") as unknown as ModDbLookup<DownloadableModTagType>
}
