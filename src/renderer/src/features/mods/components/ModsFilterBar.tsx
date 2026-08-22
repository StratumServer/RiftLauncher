import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { PiStarDuotone, PiEraserDuotone } from "react-icons/pi"

import { FormButton, FormInputText } from "@renderer/components/ui/FormComponents"
import { StickyMenuGroupWrapper, StickyMenuGroup } from "@renderer/components/ui/StickyMenu"
import AuthorFilter from "@renderer/features/mods/components/AuthorFilter"
import VersionsFilter from "@renderer/features/mods/components/VersionsFilter"
import TagsFilter from "@renderer/features/mods/components/TagsFilter"
import SideFilter from "@renderer/features/mods/components/SideFilter"
import OrderFilter from "@renderer/features/mods/components/OrderFilter"
import InstalledFilter from "@renderer/features/mods/components/InstalledFilter"

/** Every ListMods filter control: text/author/version/tag/side/installed, favorites-only, order, and clear. */
function ModsFilterBar({
  textFilter,
  setTextFilter,
  authorFilter,
  setAuthorFilter,
  versionsFilter,
  setVersionsFilter,
  tagsFilter,
  setTagsFilter,
  sideFilter,
  setSideFilter,
  installedFilter,
  setInstalledFilter,
  onlyFav,
  setOnlyFav,
  orderBy,
  setOrderBy,
  orderByOrder,
  setOrderByOrder,
  onClearFilters
}: Readonly<{
  textFilter: string
  setTextFilter: Dispatch<SetStateAction<string>>
  authorFilter: DownloadableModAuthorType
  setAuthorFilter: Dispatch<SetStateAction<DownloadableModAuthorType>>
  versionsFilter: DownloadableModGameVersionType[]
  setVersionsFilter: Dispatch<SetStateAction<DownloadableModGameVersionType[]>>
  tagsFilter: DownloadableModTagType[]
  setTagsFilter: Dispatch<SetStateAction<DownloadableModTagType[]>>
  sideFilter: string
  setSideFilter: Dispatch<SetStateAction<string>>
  installedFilter: string
  setInstalledFilter: Dispatch<SetStateAction<string>>
  onlyFav: boolean
  setOnlyFav: Dispatch<SetStateAction<boolean>>
  orderBy: string
  setOrderBy: Dispatch<SetStateAction<string>>
  orderByOrder: string
  setOrderByOrder: Dispatch<SetStateAction<string>>
  onClearFilters: () => void
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <StickyMenuGroupWrapper type="centered">
      <StickyMenuGroup>
        <FormInputText placeholder={t("generic.text")} value={textFilter} onChange={(e) => setTextFilter(e.target.value)} className="w-40 h-8" />

        <AuthorFilter authorFilter={authorFilter} setAuthorFilter={setAuthorFilter} size="w-40 h-8" />

        <VersionsFilter versionsFilter={versionsFilter} setVersionsFilter={setVersionsFilter} size="w-40 h-8" />

        <TagsFilter tagsFilter={tagsFilter} setTagsFilter={setTagsFilter} size="w-40 h-8" />

        <SideFilter sideFilter={sideFilter} setSideFilter={setSideFilter} size="w-40 h-8" />

        <InstalledFilter installedFilter={installedFilter} setInstalledFilter={setInstalledFilter} size="w-40 h-8" />

        <FormButton title={t("features.mods.onlyFavMods")} onClick={() => setOnlyFav((prev) => !prev)} className="w-8 h-8 text-lg" type={onlyFav ? "warn" : "normal"}>
          <PiStarDuotone />
        </FormButton>

        <OrderFilter orderBy={orderBy} setOrderBy={setOrderBy} orderByOrder={orderByOrder} setOrderByOrder={setOrderByOrder} />

        <FormButton title={t("generic.clearFilter")} onClick={() => onClearFilters()} className="w-8 h-8 text-lg">
          <PiEraserDuotone />
        </FormButton>
      </StickyMenuGroup>
    </StickyMenuGroupWrapper>
  )
}

export default ModsFilterBar
