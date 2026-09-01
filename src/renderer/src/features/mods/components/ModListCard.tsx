import { memo } from "react"
import { useTranslation } from "react-i18next"
import { PiDownloadDuotone, PiStarDuotone, PiChatCenteredTextDuotone, PiUserCircleDuotone } from "react-icons/pi"
import { FiExternalLink } from "react-icons/fi"
import clsx from "clsx"

import { FormButton } from "@renderer/components/ui/FormComponents"
import { GridItem } from "@renderer/components/ui/Grid"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"
import { selectableItemProps } from "@renderer/components/ui/selectableItemProps"

/** Rounds a stat down to the nearest thousand past 10k, e.g. 12345 -> "12K". */
function formatStat(value: number): string {
  return value > 10000 ? `${Math.floor(value / 1000)}K` : `${value}`
}

/**
 * One Mod in the ModDB grid: art, favorite/ModDB actions, and its stats.
 *
 * Memoized because the grid can hold hundreds of these: onSelect/onToggleFav/onOpenModDb
 * take the mod as an argument instead of being pre-bound per card, so ModsGrid can hand
 * every card the same stable callback reference and let memo actually skip cards untouched
 * by whatever caused the grid to re-render.
 */
function ModListCard({
  mod,
  installed,
  isFav,
  onSelect,
  onToggleFav,
  onOpenModDb
}: Readonly<{
  mod: DownloadableModOnListType
  installed: boolean
  isFav: boolean
  onSelect: (mod: DownloadableModOnListType) => void
  onToggleFav: (mod: DownloadableModOnListType) => void
  onOpenModDb: (mod: DownloadableModOnListType) => void
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <GridItem selected={installed} size="w-[18rem] max-w-[26rem]" className="group relative overflow-hidden">
      <div
        {...selectableItemProps({
          onClick: () => onSelect(mod),
          label: `${mod.name}, ${t(installed ? "generic.installed" : "generic.notInstalled")}`
        })}
        className="w-full h-full cursor-pointer focus-visible:outline-2 focus-visible:outline-vsl focus-visible:outline-offset-2"
      >
        <div className="relative w-full aspect-[3/2] skip-offscreen-render">
          <img src={mod.logo ? `${mod.logo}` : "https://mods.vintagestory.at/web/img/mod-default.png"} alt={mod.name} loading="lazy" className="w-full h-full object-cover object-top" />
        </div>

        <div className="w-full aspect-[3/1] flex text-sm skip-offscreen-render">
          <div className="shrink-0 w-1/3 flex flex-col gap-1 px-2 py-1 overflow-hidden">
            <p className="flex items-center gap-1" title={mod.author}>
              <PiUserCircleDuotone className="shrink-0 opacity-50" />
              <span className="overflow-hidden whitespace-nowrap text-ellipsis">{mod.author}</span>
            </p>
            <p className="flex items-center gap-1">
              <PiDownloadDuotone className="shrink-0 opacity-50" />
              <span>{formatStat(Number(mod.downloads))}</span>
            </p>
            <p className="flex items-center gap-1">
              <PiStarDuotone className="shrink-0 opacity-50" />
              <span>{formatStat(Number(mod.follows))}</span>
            </p>
            <p className="flex items-center gap-1">
              <PiChatCenteredTextDuotone className="shrink-0 opacity-50" />
              <span>{formatStat(Number(mod.comments))}</span>
            </p>
          </div>

          <ThinSeparator />

          <div className="w-full flex flex-col gap-1 px-2 py-1 overflow-hidden">
            <p className="text-base font-bold overflow-hidden whitespace-nowrap text-ellipsis" title={mod.name}>
              {mod.name}
            </p>
            <p className="text-zinc-400 line-clamp-3" title={mod.summary ?? ""}>
              {mod.summary}
            </p>
          </div>
        </div>
      </div>

      <div className="absolute w-full top-0 flex items-center justify-between p-1">
        <FormButton
          title={t("generic.favorite")}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFav(mod)
          }}
          className={clsx("p-1 text-lg", !isFav && "opacity-0 group-hover:opacity-100 duration-200")}
          type={isFav ? "warn" : "normal"}
        >
          <PiStarDuotone />
        </FormButton>

        <FormButton
          title={t("features.mods.openOnTheModDB")}
          onClick={(e) => {
            e.stopPropagation()
            onOpenModDb(mod)
          }}
          className="p-1 text-lg opacity-0 group-hover:opacity-100 duration-200"
        >
          <FiExternalLink />
        </FormButton>
      </div>
    </GridItem>
  )
}

export default memo(ModListCard)
