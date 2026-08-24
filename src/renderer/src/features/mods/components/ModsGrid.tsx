import { useTranslation } from "react-i18next"
import { FiLoader } from "react-icons/fi"

import { GridGroup, GridWrapper } from "@renderer/components/ui/Grid"
import ModListCard from "@renderer/features/mods/components/ModListCard"

/** The ModDB results grid: a loading/empty state, or the visible slice of Mods as cards. */
function ModsGrid({
  mods,
  visibleCount,
  searching,
  isModInstalled,
  isModFav,
  onSelectMod,
  onToggleFavMod,
  onOpenModDb
}: Readonly<{
  mods: DownloadableModOnListType[]
  visibleCount: number
  searching: boolean
  isModInstalled: (mod: DownloadableModOnListType) => boolean
  isModFav: (mod: DownloadableModOnListType) => boolean
  onSelectMod: (mod: DownloadableModOnListType) => void
  onToggleFavMod: (mod: DownloadableModOnListType) => void
  onOpenModDb: (mod: DownloadableModOnListType) => void
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <GridWrapper className="my-auto">
      <GridGroup>
        {mods.length < 1 ? (
          <div className="w-full flex flex-col items-center justify-center gap-2 rounded-sm p-4">
            {searching ? <FiLoader className="animate-spin text-4xl text-zinc-400" /> : t("features.mods.noMatchingFilters")}
          </div>
        ) : (
          mods
            .slice(0, visibleCount)
            .map((mod) => <ModListCard key={mod.modid} mod={mod} installed={isModInstalled(mod)} isFav={isModFav(mod)} onSelect={onSelectMod} onToggleFav={onToggleFavMod} onOpenModDb={onOpenModDb} />)
        )}
      </GridGroup>
    </GridWrapper>
  )
}

export default ModsGrid
