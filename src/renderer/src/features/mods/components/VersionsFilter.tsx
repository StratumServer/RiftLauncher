import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"

import { useGameVersionsLookup } from "@renderer/features/mods/hooks/useModDbLookups"
import MultiSelectFilter from "@renderer/components/ui/MultiSelectFilter"

function VersionsFilter({
  versionsFilter,
  setVersionsFilter,
  size = "w-full h-8"
}: Readonly<{
  versionsFilter: DownloadableModGameVersionType[]
  setVersionsFilter: Dispatch<SetStateAction<DownloadableModGameVersionType[]>>
  size?: string
}>): JSX.Element {
  const { t } = useTranslation()
  const { entries: gameVersionsList, failed: lookupFailed } = useGameVersionsLookup()

  return (
    <MultiSelectFilter
      selected={versionsFilter}
      onChange={setVersionsFilter}
      options={gameVersionsList}
      lookupFailed={lookupFailed}
      placeholder={t("generic.versions")}
      lookupFailedMessage={t("features.mods.errorFetchingMods")}
      size={size}
    />
  )
}

export default VersionsFilter
