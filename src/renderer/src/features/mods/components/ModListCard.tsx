import { useTranslation } from "react-i18next"
import { PiDownloadDuotone, PiStarDuotone, PiChatCenteredTextDuotone, PiUserCircleDuotone } from "react-icons/pi"
import { FiExternalLink } from "react-icons/fi"
import clsx from "clsx"

import { FormButton } from "@renderer/components/ui/FormComponents"
import { GridItem } from "@renderer/components/ui/Grid"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"

/** Rounds a stat down to the nearest thousand past 10k, e.g. 12345 -> "12K". */
function formatStat(value: number): string {
  return value > 10000 ? `${Math.floor(value / 1000)}K` : `${value}`
}

/** One Mod in the ModDB grid: art, favorite/ModDB actions, and its stats. */
function ModListCard({
  mod,
  installed,
  isFav,
  onSelect,
  onToggleFav,
  onOpenModDb
}: {
  mod: DownloadableModOnListType
  installed: boolean
  isFav: boolean
  onSelect: () => void
  onToggleFav: () => void
  onOpenModDb: () => void
}): JSX.Element {
  const { t } = useTranslation()

  return (
    <GridItem onClick={onSelect} selected={installed} size="w-[18rem] max-w-[26rem]" className="group overflow-hidden">
      <div className="relative w-full aspect-[3/2]">
        <img src={mod.logo ? `${mod.logo}` : "https://mods.vintagestory.at/web/img/mod-default.png"} alt={mod.name} className="w-full h-full object-cover object-top" />

        <div className="absolute w-full top-0 flex items-center justify-between p-1">
          <FormButton
            title={t("generic.favorite")}
            onClick={(e) => {
              e.stopPropagation()
              onToggleFav()
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
              onOpenModDb()
            }}
            className="p-1 text-lg opacity-0 group-hover:opacity-100 duration-200"
          >
            <FiExternalLink />
          </FormButton>
        </div>
      </div>

      <div className="w-full aspect-[3/1] flex text-sm">
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
    </GridItem>
  )
}

export default ModListCard
