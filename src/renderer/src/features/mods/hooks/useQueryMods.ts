import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { parseModListResponse } from "@domain/mods/moddb"

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
      if (versionsFilter && versionsFilter.length > 0) versionsFilter.map((version) => filters.push(`gameversions[]=${version.tagid}`))
      if (tagsFilter && tagsFilter.length > 0) tagsFilter.map((tag) => filters.push(`tagids[]=${tag.tagid}`))
      filters.push(`orderby=${orderBy}`)
      filters.push(`orderdirection=${orderByOrder}`)

      const res = await window.api.netManager.queryURL(`https://mods.vintagestory.at/api/mods${filters.length > 0 && `?${filters.join("&")}`}`)
      const parsed = parseModListResponse(res)

      if (onFinish) onFinish()

      // The ModDB answers an application error with a real HTTP 200, so a missing or bad
      // `statuscode` never throws: it has to be checked explicitly, or every caller downstream
      // (ListMods.tsx runs unguarded `mods.filter(...)` on the result) sees `undefined` typed as a
      // list and crashes on the first filter.
      if (!parsed.ok) {
        window.api.utils.logMessage(
          "error",
          `[front] [mods] [features/mods/hooks/useQueryMods.ts] [useQueryMods > queryMods] Mods query failed: ${parsed.reason}${parsed.statusCode ? ` (statuscode ${parsed.statusCode})` : ""}.`
        )
        addNotification(t("features.mods.errorFetchingMods"), "error")
        return []
      }

      return parsed.payload as unknown as DownloadableModOnListType[]
    } catch (err) {
      window.api.utils.logMessage("error", `[front] [mods] [features/mods/hooks/useQueryMods.ts] [useQueryMods > queryMods] Error fetching mods.`)
      window.api.utils.logMessage("debug", `[front] [mods] [features/mods/hooks/useQueryMods.ts] [useQueryMods > queryMods] Error fetching mods: ${err}`)
      addNotification(t("features.mods.errorFetchingMods"), "error")
      return []
    }
  }

  return queryMods
}
