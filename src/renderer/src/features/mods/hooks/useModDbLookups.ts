import { useEffect, useState } from "react"

import { parseAuthorsResponse, parseGameVersionsResponse, parseTagsResponse } from "@domain/mods/moddb"
import type { ModDbNamedEntry, ModDbResponse } from "@domain/mods/moddb"
import { queryModDb } from "@renderer/features/moddb/adapters/moddb"
import { logMods } from "@renderer/features/moddb/adapters/log"

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
): ModDbNamedEntry[] {
  const [list, setList] = useState<ModDbNamedEntry[]>([])

  useEffect(() => {
    let cancelled = false

    ;(async (): Promise<void> => {
      try {
        const res = await queryModDb(path)
        const parsed = parse(res)

        if (!parsed.ok) {
          logMods("debug", `[front] [mods] [features/mods/hooks/useModDbLookups.ts] [${tag} > queryModDb] Query failed: ${parsed.reason}.`)
          return
        }

        if (!cancelled) setList(transform(parsed.payload))
      } catch (err) {
        logMods("error", `[front] [mods] [features/mods/hooks/useModDbLookups.ts] [${tag} > queryModDb] Error fetching ${tag}.`)
        logMods("debug", `[front] [mods] [features/mods/hooks/useModDbLookups.ts] [${tag} > queryModDb] Error fetching ${tag}: ${err}`)
      }
    })()

    return (): void => {
      cancelled = true
    }
  }, [])

  return list
}

export function useAuthorsLookup(): DownloadableModAuthorType[] {
  return useModDbNamedListLookup("/authors", parseAuthorsResponse, "AuthorFilter") as unknown as DownloadableModAuthorType[]
}

/** Reversed to match the ModDB's newest-first listing, same as the pre-refactor VersionsFilter did. */
export function useGameVersionsLookup(): DownloadableModGameVersionType[] {
  return useModDbNamedListLookup("/gameversions", parseGameVersionsResponse, "VersionsFilter", (list) => [...list].reverse()) as unknown as DownloadableModGameVersionType[]
}

export function useTagsLookup(): DownloadableModTagType[] {
  return useModDbNamedListLookup("/tags", parseTagsResponse, "TagsFilter") as unknown as DownloadableModTagType[]
}
