import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { PiEraserDuotone } from "react-icons/pi"

import { FormButton } from "@renderer/components/ui/FormComponents"
import { StickyMenuGroupWrapper, StickyMenuGroup } from "@renderer/components/ui/StickyMenu"
import InstalledAuthorFilter from "@renderer/features/mods/components/InstalledAuthorFilter"
import InstalledTagsFilter from "@renderer/features/mods/components/InstalledTagsFilter"
import InstalledVersionFilter from "@renderer/features/mods/components/InstalledVersionFilter"

/** Filter controls for the installed mods list: author, tag, version, and clear. */
function InstalledModsFilterBar({
  authorFilter,
  setAuthorFilter,
  authors,
  tagsFilter,
  setTagsFilter,
  tags,
  versionFilter,
  setVersionFilter,
  versions,
  onClearFilters
}: Readonly<{
  authorFilter: string
  setAuthorFilter: Dispatch<SetStateAction<string>>
  authors: string[]
  tagsFilter: string[]
  setTagsFilter: Dispatch<SetStateAction<string[]>>
  tags: string[]
  versionFilter: string
  setVersionFilter: Dispatch<SetStateAction<string>>
  versions: string[]
  onClearFilters: () => void
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <StickyMenuGroupWrapper type="centered">
      <StickyMenuGroup>
        <InstalledAuthorFilter authorFilter={authorFilter} setAuthorFilter={setAuthorFilter} authors={authors} />

        {tags.length > 0 && <InstalledTagsFilter tagsFilter={tagsFilter} setTagsFilter={setTagsFilter} tags={tags} />}

        <InstalledVersionFilter versionFilter={versionFilter} setVersionFilter={setVersionFilter} versions={versions} />

        <FormButton title={t("generic.clearFilter")} onClick={() => onClearFilters()} className="w-8 h-8 text-lg">
          <PiEraserDuotone />
        </FormButton>
      </StickyMenuGroup>
    </StickyMenuGroupWrapper>
  )
}

export default InstalledModsFilterBar
