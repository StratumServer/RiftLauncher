import { SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { PiStarDuotone, PiStarFill, PiEraserDuotone } from "react-icons/pi"
import clsx from "clsx"

import type { ModsFilters } from "@renderer/features/mods/modsBrowseState"

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
  filters,
  setFilter,
  onClearFilters
}: Readonly<{
  filters: ModsFilters
  setFilter: <K extends keyof ModsFilters>(key: K, value: SetStateAction<ModsFilters[K]>) => void
  onClearFilters: () => void
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <StickyMenuGroupWrapper type="centered">
      <StickyMenuGroup>
        <FormInputText placeholder={t("generic.text")} value={filters.textFilter} onChange={(e) => setFilter("textFilter", e.target.value)} className="w-40 h-8" />

        <AuthorFilter authorFilter={filters.authorFilter} setAuthorFilter={(value) => setFilter("authorFilter", value)} size="w-40 h-8" />

        <VersionsFilter versionsFilter={filters.versionsFilter} setVersionsFilter={(value) => setFilter("versionsFilter", value)} size="w-40 h-8" />

        <TagsFilter tagsFilter={filters.tagsFilter} setTagsFilter={(value) => setFilter("tagsFilter", value)} size="w-40 h-8" />

        <SideFilter sideFilter={filters.sideFilter} setSideFilter={(value) => setFilter("sideFilter", value)} size="w-40 h-8" />

        <InstalledFilter installedFilter={filters.installedFilter} setInstalledFilter={(value) => setFilter("installedFilter", value)} size="w-40 h-8" />

        {/*
         * The active hue goes on the icon, never on the FormButton: the ghost variant carries
         * `text-zinc-200` and Tailwind emits it after a class handed through `className`, so a
         * colour on the button loses the cascade and paints nothing (issue #414, same as #366,
         * see ModReleaseList.tsx). The border does win from `className`, and the fill icon makes
         * the on state a shape change, not a hue change (WCAG 1.4.1).
         */}
        <FormButton
          title={t("features.mods.onlyFavMods")}
          onClick={() => setFilter("onlyFav", !filters.onlyFav)}
          className={clsx("w-8 h-8 text-lg", filters.onlyFav && "border-vsl")}
          variant="ghost"
          ariaPressed={filters.onlyFav}
        >
          {filters.onlyFav ? <PiStarFill className="text-yellow-400" /> : <PiStarDuotone />}
        </FormButton>

        <OrderFilter orderBy={filters.orderBy} setOrderBy={(value) => setFilter("orderBy", value)} orderByOrder={filters.orderByOrder} setOrderByOrder={(value) => setFilter("orderByOrder", value)} />

        <FormButton title={t("generic.clearFilter")} onClick={() => onClearFilters()} className="w-8 h-8 text-lg" variant="ghost">
          <PiEraserDuotone />
        </FormButton>
      </StickyMenuGroup>
    </StickyMenuGroupWrapper>
  )
}

export default ModsFilterBar
