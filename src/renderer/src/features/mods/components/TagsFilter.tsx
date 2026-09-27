import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"

import { useTagsLookup } from "@renderer/features/mods/hooks/useModDbLookups"
import MultiSelectFilter from "@renderer/components/ui/MultiSelectFilter"

function TagsFilter({
  tagsFilter,
  setTagsFilter,
  size = "w-full h-8"
}: Readonly<{
  tagsFilter: DownloadableModTagType[]
  setTagsFilter: Dispatch<SetStateAction<DownloadableModTagType[]>>
  size?: string
}>): JSX.Element {
  const { t } = useTranslation()
  const { entries: tagsList, failed: lookupFailed } = useTagsLookup()

  return (
    <MultiSelectFilter
      selected={tagsFilter}
      onChange={setTagsFilter}
      options={tagsList}
      lookupFailed={lookupFailed}
      placeholder={t("generic.tags")}
      lookupFailedMessage={t("features.mods.errorFetchingMods")}
      hashPrefix
      size={size}
    />
  )
}

export default TagsFilter
