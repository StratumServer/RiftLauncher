import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { parseModListResponse } from "@domain/mods/moddb"
import { MAX_SUGGESTION_DETAIL_LOOKUPS, MAX_SUGGESTIONS, rankSuggestions, resolveSuggestions, type ResolvedSuggestion, type SuggestionInstallation } from "@domain/mods/suggestions"
import { queryModDb } from "@renderer/features/moddb/adapters/moddb"
import type { QueryModOutcome } from "@renderer/features/mods/hooks/useQueryMod"
import { logMods } from "@renderer/features/moddb/adapters/log"

export interface ModSuggestionsState {
  readonly suggestions: readonly ResolvedSuggestion[]
  readonly loading: boolean
  readonly refresh: () => void
}

/**
 * Loads the optional suggestions row in two deliberately separate phases: one bare catalog
 * snapshot, then at most twenty detail checks in rank order. The effect owns an AbortController so
 * a refresh, Installation switch, or unmount cannot paint the result of an older request.
 */
export function useModSuggestions({
  consent,
  installation,
  installations,
  installedMods,
  dismissedListingIds,
  getInstalledMods,
  queryMod
}: Readonly<{
  consent: boolean | null
  installation: InstallationType | undefined
  installations: readonly InstallationType[]
  installedMods: readonly InstalledModType[] | undefined
  dismissedListingIds: readonly number[]
  getInstalledMods: ({ path }: { path: string }) => Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }>
  queryMod: ({ modid }: { modid: number | string }) => Promise<QueryModOutcome>
}>): ModSuggestionsState {
  const [suggestions, setSuggestions] = useState<readonly ResolvedSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshNumber, setRefreshNumber] = useState(0)
  const installationId = installation?.id
  const installationPath = installation?.path
  const installationVersion = installation?.version
  const dismissedListingIdsRef = useRef(dismissedListingIds)
  dismissedListingIdsRef.current = dismissedListingIds

  const refresh = useCallback(() => setRefreshNumber((number) => number + 1), [])

  useEffect(() => {
    if (consent !== true || !installationId || !installationPath || !installationVersion || !installedMods) {
      setSuggestions([])
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setLoading(true)

    void (async (): Promise<void> => {
      try {
        // This path is intentionally unfiltered. The browse grid's current search/order is not a
        // suggestions input, and this is the one request that gives the pure ranker a complete view.
        const catalogResponse = await queryModDb("/mods")
        if (controller.signal.aborted) return

        const catalog = parseModListResponse(catalogResponse)
        if (!catalog.ok) {
          logMods("error", `[front] [mods] [features/mods/hooks/useModSuggestions.ts] Catalog snapshot failed: ${catalog.reason}.`)
          setSuggestions([])
          return
        }

        const otherInstallations: SuggestionInstallation[] = []
        for (const other of installations) {
          if (other.id === installationId) continue
          if (controller.signal.aborted) return

          const scanned = await getInstalledMods({ path: other.path })
          if (controller.signal.aborted) return
          otherInstallations.push({ id: other.id, version: other.version, mods: scanned.mods })
        }

        const current: SuggestionInstallation = { id: installationId, version: installationVersion, mods: installedMods }
        const ranked = rankSuggestions({
          catalog: catalog.payload as unknown as DownloadableModOnListType[],
          installation: current,
          otherInstallations,
          targetGameVersion: installationVersion,
          dismissedListingIds: dismissedListingIdsRef.current,
          now: Date.now()
        })

        const resolved = await resolveSuggestions({
          candidates: ranked,
          targetGameVersion: installationVersion,
          maxSuggestions: MAX_SUGGESTION_DETAIL_LOOKUPS,
          signal: controller.signal,
          getDetail: async (listingId) => {
            if (controller.signal.aborted) return undefined
            const outcome = await queryMod({ modid: listingId })
            return outcome.status === "found" ? outcome.mod : undefined
          }
        })

        if (!controller.signal.aborted) setSuggestions(resolved)
      } catch (error) {
        if (!controller.signal.aborted) {
          logMods("error", `[front] [mods] [features/mods/hooks/useModSuggestions.ts] Suggestions failed: ${error}.`)
          setSuggestions([])
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()

    return (): void => controller.abort()
  }, [consent, installationId, installationPath, installationVersion, installations, installedMods, getInstalledMods, queryMod, refreshNumber])

  const visibleSuggestions = useMemo(() => {
    const dismissed = new Set(dismissedListingIds)
    return suggestions.filter(({ mod }) => !dismissed.has(mod.modid)).slice(0, MAX_SUGGESTIONS)
  }, [dismissedListingIds, suggestions])

  return { suggestions: visibleSuggestions, loading, refresh }
}
