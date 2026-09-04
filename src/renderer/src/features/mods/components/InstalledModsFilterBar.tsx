import { useTranslation } from "react-i18next"
import { PiEraserDuotone } from "react-icons/pi"

import { FormButton } from "@renderer/components/ui/FormComponents"
import { StickyMenuGroup } from "@renderer/components/ui/StickyMenu"
import InstalledModsSelectFilter from "@renderer/features/mods/components/InstalledModsSelectFilter"
import InstalledTagsFilter from "@renderer/features/mods/components/InstalledTagsFilter"
import type { InstalledModFilters } from "@domain/mods/installedFilters"

/**
 * Filter controls for the installed mods list: author, tag, game version, and clear.
 *
 * A bare group, not a StickyMenuGroupWrapper: ManageMods already renders one around the search
 * field, and this bar sits inside it as a second group.
 *
 * The tag and game version controls come from the ModDB detail lookup rather than the archives, so
 * each stays off screen while its list is empty. That keeps a run with no network from offering a
 * filter that would hide every mod. Author reads the local modinfo and is always here.
 */
function InstalledModsFilterBar({
  filters,
  setFilters,
  authors,
  tags,
  gameVersions,
  onClearFilters
}: Readonly<{
  filters: InstalledModFilters
  setFilters: (update: (prev: InstalledModFilters) => InstalledModFilters) => void
  authors: string[]
  tags: string[]
  gameVersions: string[]
  onClearFilters: () => void
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <StickyMenuGroup>
      <InstalledModsSelectFilter
        value={filters.author}
        onChange={(author) => setFilters((prev) => ({ ...prev, author }))}
        options={authors}
        label={t("generic.author")}
        anyLabel={t("generic.anyAuthor")}
      />

      {tags.length > 0 && <InstalledTagsFilter tagsFilter={[...filters.tags]} setTagsFilter={(next) => setFilters((prev) => ({ ...prev, tags: next }))} tags={tags} />}

      {gameVersions.length > 0 && (
        <InstalledModsSelectFilter
          value={filters.gameVersion}
          onChange={(gameVersion) => setFilters((prev) => ({ ...prev, gameVersion }))}
          options={gameVersions}
          label={t("features.versions.labelGameVersion")}
          anyLabel={t("generic.anyGameVersion")}
        />
      )}

      <FormButton title={t("generic.clearFilter")} onClick={() => onClearFilters()} className="w-8 h-8 text-lg">
        <PiEraserDuotone />
      </FormButton>
    </StickyMenuGroup>
  )
}

export default InstalledModsFilterBar
