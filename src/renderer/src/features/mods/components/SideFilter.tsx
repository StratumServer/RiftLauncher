import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"

import SelectMenu from "@renderer/components/ui/SelectMenu"

function SideFilter({ sideFilter, setSideFilter, size = "w-full h-8" }: Readonly<{ sideFilter: string; setSideFilter: Dispatch<SetStateAction<string>>; size?: string }>): JSX.Element {
  const { t } = useTranslation()

  const SIDE_FILTERS = [
    { key: "any", label: t("generic.any") },
    { key: "both", label: t("generic.both") },
    { key: "server", label: t("generic.server") },
    { key: "client", label: t("generic.client") }
  ]

  return <SelectMenu value={sideFilter} options={SIDE_FILTERS} onChange={setSideFilter} size={size} />
}

export default SideFilter
