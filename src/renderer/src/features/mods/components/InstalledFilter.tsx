import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"

import SelectMenu from "@renderer/components/ui/SelectMenu"

function InstalledFilter({
  installedFilter,
  setInstalledFilter,
  size = "w-full h-8"
}: Readonly<{ installedFilter: string; setInstalledFilter: Dispatch<SetStateAction<string>>; size?: string }>): JSX.Element {
  const { t } = useTranslation()

  const INSTALLED_FILTERS = [
    { key: "all", label: t("generic.all") },
    { key: "installed", label: t("generic.installed") },
    { key: "not-installed", label: t("generic.notInstalled") }
  ]

  return <SelectMenu value={installedFilter} options={INSTALLED_FILTERS} onChange={setInstalledFilter} size={size} />
}

export default InstalledFilter
