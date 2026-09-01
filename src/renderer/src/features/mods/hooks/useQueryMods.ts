import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { parseModListResponse } from "@domain/mods/moddb"
import { queryModDb } from "@renderer/features/moddb/adapters/moddb"
import { logMods } from "@renderer/features/moddb/adapters/log"

/**
 * How long a query's result is trusted before a repeat of the exact same filters goes back
 * to the network. Long enough that toggling a filter on and back off, or leaving the mods
 * page and returning to it, stays free; short enough that a search someone returns to later
 * still sees roughly current download/follow counts.
 */
const QUERY_CACHE_TTL_MS = 2 * 60 * 1_000

/** How many distinct filter combinations to remember at once. */
const MAX_CACHED_QUERIES = 20

/**
 * Module-scoped on purpose: every ListMods instance (and any future caller) searches the
 * same global ModDB catalog, so a result cached for one is valid for all of them. Keyed by
 * the exact request path queryMods already builds, so there is no separate key-building
 * logic to keep in sync with it.
 */
const queryCache = new Map<string, { mods: DownloadableModOnListType[]; cachedAt: number }>()

function getCachedQuery(key: string): DownloadableModOnListType[] | undefined {
  const cached = queryCache.get(key)
  if (!cached) return undefined

  if (Date.now() - cached.cachedAt > QUERY_CACHE_TTL_MS) {
    queryCache.delete(key)
    return undefined
  }

  // Re-inserting moves the key to the end of the Map's insertion-ordered iteration, which
  // is what makes the first key visited below the least recently used.
  queryCache.delete(key)
  queryCache.set(key, cached)
  return cached.mods
}

/** Empties the shared query cache. Exists for tests: production never needs a cold cache. */
export function clearQueryCache(): void {
  queryCache.clear()
}

function rememberQuery(key: string, mods: DownloadableModOnListType[]): void {
  queryCache.delete(key)
  queryCache.set(key, { mods, cachedAt: Date.now() })

  if (queryCache.size > MAX_CACHED_QUERIES) {
    const oldestKey = queryCache.keys().next().value
    if (oldestKey !== undefined) queryCache.delete(oldestKey)
  }
}

export function useQueryMods(): ({
  textFilter,
  authorFilter,
  versionsFilter,
  tagsFilter,
  orderBy,
  orderByOrder,
  onFinish
}: {
  textFilter?: string
  authorFilter?: DownloadableModAuthorType
  versionsFilter?: DownloadableModGameVersionType[]
  tagsFilter?: DownloadableModTagType[]
  orderBy?: string
  orderByOrder?: string
  onFinish?: () => void
}) => Promise<DownloadableModOnListType[]> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  /**
   * Makes a query and returns all the mods. Accepts the listed filters.
   *
   * @param {object} props
   * @param {string} [props.textFilter] Optional string to filter by name and description.
   * @param {DownloadableModAuthorType} [props.authorFilter] Optional author to filter by.
   * @param {DownloadableModGameVersionType[]} [props.versionsFilter] Optional list of versions to filter by.
   * @param {string} [props.orderBy] Optional string to order by. Defaults to "follows".
   * @param {string} [props.orderByOrder] Optional string to set the order. Defaults to "desc".
   * @param {() => void} [props.onFinish] Optional function that will be called just before returning the mods list.
   * @returns {Promise<void>}
   */
  async function queryMods({
    textFilter,
    authorFilter,
    versionsFilter,
    tagsFilter,
    orderBy = "follows",
    orderByOrder = "desc",
    onFinish
  }: {
    textFilter?: string
    authorFilter?: DownloadableModAuthorType
    versionsFilter?: DownloadableModGameVersionType[]
    tagsFilter?: DownloadableModTagType[]
    orderBy?: string
    orderByOrder?: string
    onFinish?: () => void
  }): Promise<DownloadableModOnListType[]> {
    try {
      const filters: string[] = []

      if (textFilter && textFilter.length > 1) filters.push(`text=${textFilter}`)
      if (authorFilter && authorFilter.name.length > 1) filters.push(`author=${authorFilter.userid}`)
      if (versionsFilter && versionsFilter.length > 0) versionsFilter.forEach((version) => filters.push(`gameversions[]=${version.tagid}`))
      if (tagsFilter && tagsFilter.length > 0) tagsFilter.forEach((tag) => filters.push(`tagids[]=${tag.tagid}`))
      filters.push(`orderby=${orderBy}`, `orderdirection=${orderByOrder}`)

      const queryString = filters.length > 0 ? `?${filters.join("&")}` : ""
      const requestPath = `/mods${queryString}`

      const cached = getCachedQuery(requestPath)
      if (cached) {
        if (onFinish) onFinish()
        return cached
      }

      const res = await queryModDb(requestPath)
      const parsed = parseModListResponse(res)

      if (onFinish) onFinish()

      // The ModDB answers an application error with a real HTTP 200, so a missing or bad
      // `statuscode` never throws: it has to be checked explicitly, or every caller downstream
      // (ListMods.tsx runs unguarded `mods.filter(...)` on the result) sees `undefined` typed as a
      // list and crashes on the first filter.
      if (!parsed.ok) {
        logMods(
          "error",
          `[front] [mods] [features/mods/hooks/useQueryMods.ts] [useQueryMods > queryMods] Mods query failed: ${parsed.reason}${parsed.statusCode ? ` (statuscode ${parsed.statusCode})` : ""}.`
        )
        addNotification(t("features.mods.errorFetchingMods"), "error")
        return []
      }

      const mods = parsed.payload as unknown as DownloadableModOnListType[]
      rememberQuery(requestPath, mods)
      return mods
    } catch (err) {
      logMods("error", `[front] [mods] [features/mods/hooks/useQueryMods.ts] [useQueryMods > queryMods] Error fetching mods.`)
      logMods("debug", `[front] [mods] [features/mods/hooks/useQueryMods.ts] [useQueryMods > queryMods] Error fetching mods: ${err}`)
      addNotification(t("features.mods.errorFetchingMods"), "error")
      return []
    }
  }

  return queryMods
}
