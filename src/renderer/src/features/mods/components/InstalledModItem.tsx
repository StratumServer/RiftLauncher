import { useTranslation } from "react-i18next"
import { PiArrowClockwiseDuotone, PiMoonDuotone, PiTrashDuotone } from "react-icons/pi"
import { FiExternalLink } from "react-icons/fi"
import clsx from "clsx"

import { useExternalLinks } from "@renderer/hooks/useExternalLinks"

import { ListItem } from "@renderer/components/ui/List"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"

/** One installed Mod's row: art, identity, and the suspend/update/ModDB/delete actions. */
function InstalledModItem({
  iMod,
  suspended,
  onToggleSuspendClick,
  onDeleteClick,
  onUpdateClick
}: Readonly<{
  iMod: InstalledModType
  /** Update All skips this Mod. The row still says an update exists, and still offers it. */
  suspended: boolean
  onToggleSuspendClick: () => void
  onDeleteClick: () => void
  onUpdateClick: () => void
}>): JSX.Element {
  const { t } = useTranslation()
  const { openOnBrowser: openExternalLink } = useExternalLinks()

  return (
    <ListItem key={iMod.modid + iMod.path}>
      <div
        className={clsx(
          "h-20 flex gap-4 p-2 justify-between items-center whitespace-nowrap skip-offscreen-render",
          // Suspension wins the tint: it is a decision the player made, and it is the one thing
          // about the row that the update state alone cannot explain.
          suspended ? "bg-sky-500/25" : iMod._updatableTo ? "bg-lime-600/25" : iMod._lastVersion && "bg-yellow-400/25"
        )}
      >
        <div className="shrink-0">
          {iMod._image ? (
            <img src={`cachemodimg:${iMod._image}`} alt={iMod.name} loading="lazy" className="w-16 h-16 object-cover rounded-sm" />
          ) : (
            <div className="w-16 h-16 bg-zinc-900 rounded-sm shadow-sm shadow-zinc-950" />
          )}
        </div>

        <ThinSeparator />

        <div className="w-full flex flex-col gap-1 justify-center overflow-hidden">
          <div className="flex gap-2 items-center">
            <p className="font-bold">{iMod.name}</p>
            <span>·</span>
            <p>v{iMod.version}</p>
          </div>

          {iMod.description && (
            <div className="overflow-hidden">
              <p className="text-sm text-zinc-400 overflow-hidden whitespace-nowrap text-ellipsis">{iMod.description}</p>
            </div>
          )}

          <div className="flex gap-2 items-center text-sm text-zinc-400">
            {iMod.authors && iMod.authors?.length > 0 && (
              <p className="shrink-0 overflow-hidden whitespace-nowrap text-ellipsis">
                {t("generic.authors")}: {iMod.authors?.join(", ")}
              </p>
            )}

            {iMod.authors && iMod.contributors && iMod.authors?.length > 0 && iMod.contributors?.length > 0 && <span>·</span>}

            {iMod.contributors && iMod.contributors?.length > 0 && (
              <p className="overflow-hidden whitespace-nowrap text-ellipsis">
                {t("generic.contributors")}: {iMod.contributors?.join(", ")}
              </p>
            )}
          </div>
        </div>

        <ThinSeparator />

        <div className="flex gap-1 justify-end text-lg">
          <NormalButton className="p-1" title={suspended ? t("features.mods.resumeUpdates") : t("features.mods.suspendUpdates")} type={suspended ? "warn" : "normal"} onClick={onToggleSuspendClick}>
            <PiMoonDuotone />
          </NormalButton>

          <NormalButton
            className="p-1"
            title={t("generic.update")}
            onClick={async () => {
              onUpdateClick()
            }}
          >
            <PiArrowClockwiseDuotone />
          </NormalButton>

          <NormalButton
            className="p-1"
            title={t("features.mods.openOnTheModDB")}
            onClick={(e) => {
              e.stopPropagation()
              openExternalLink(`https://mods.vintagestory.at/show/mod/${iMod._mod?.assetid}`)
            }}
          >
            <FiExternalLink />
          </NormalButton>

          <NormalButton
            className="p-1"
            title={t("generic.delete")}
            onClick={async () => {
              onDeleteClick()
            }}
          >
            <PiTrashDuotone />
          </NormalButton>
        </div>
      </div>
    </ListItem>
  )
}

export default InstalledModItem
