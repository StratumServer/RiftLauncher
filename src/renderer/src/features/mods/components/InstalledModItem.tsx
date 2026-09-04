import { useTranslation } from "react-i18next"
import { PiArrowClockwiseDuotone, PiMoonDuotone, PiPowerDuotone, PiTrashDuotone } from "react-icons/pi"
import { FiExternalLink } from "react-icons/fi"
import clsx from "clsx"

import { useExternalLinks } from "@renderer/hooks/useExternalLinks"

import { ListItem } from "@renderer/components/ui/List"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"

/** One installed Mod's row: art, identity, and the enable/suspend/update/ModDB/delete actions. */
function InstalledModItem({
  iMod,
  suspended,
  busy,
  onToggleEnabledClick,
  onToggleSuspendClick,
  onDeleteClick,
  onUpdateClick
}: Readonly<{
  iMod: InstalledModType
  /** Update All skips this Mod. The row still says an update exists, and still offers it. */
  suspended: boolean
  /**
   * A call that renames or replaces this archive is in flight, up to and including the rescan that
   * follows it. Everything that would act on the name the row is holding is off until it lands; the
   * two that only read it, ModDB and suspension, stay live.
   */
  busy?: boolean
  onToggleEnabledClick: () => void
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
          // Being off wins the tint outright: whatever else the row has to say about updates or
          // suspension, the game is not loading this Mod at all, and that is the headline.
          !iMod.enabled ? "bg-zinc-500/25" : suspended ? "bg-sky-500/25" : iMod._updatableTo ? "bg-lime-600/25" : iMod._lastVersion && "bg-yellow-400/25"
        )}
      >
        {/* Only what describes the Mod is greyed. The buttons keep their contrast, because the one
            that turns it back on has to stay as readable as every other row's. */}
        <div className={clsx("shrink-0", !iMod.enabled && "opacity-50 grayscale")}>
          {iMod._image ? (
            <img src={`cachemodimg:${iMod._image}`} alt={iMod.name} loading="lazy" className="w-16 h-16 object-cover rounded-sm" />
          ) : (
            <div className="w-16 h-16 bg-zinc-900 rounded-sm shadow-sm shadow-zinc-950" />
          )}
        </div>

        <ThinSeparator />

        <div className={clsx("w-full flex flex-col gap-1 justify-center overflow-hidden", !iMod.enabled && "opacity-50")}>
          <div className="flex gap-2 items-center">
            <p className="font-bold">{iMod.name}</p>
            <span>·</span>
            <p>v{iMod.version}</p>
            {!iMod.enabled && (
              <>
                <span>·</span>
                <p className="text-sm uppercase tracking-wide text-zinc-300">{t("features.mods.disabledLabel")}</p>
              </>
            )}
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
          <NormalButton
            title={iMod.enabled ? t("features.mods.disableMod") : t("features.mods.enableMod")}
            variant="ghost"
            className={clsx("p-1", !iMod.enabled && "text-yellow-400")}
            disabled={busy}
            onClick={onToggleEnabledClick}
          >
            <PiPowerDuotone />
          </NormalButton>

          <NormalButton
            className={clsx("p-1", suspended && "text-yellow-400")}
            title={suspended ? t("features.mods.resumeUpdates") : t("features.mods.suspendUpdates")}
            variant="ghost"
            onClick={onToggleSuspendClick}
          >
            <PiMoonDuotone />
          </NormalButton>

          <NormalButton
            className="p-1"
            title={t("generic.update")}
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              onUpdateClick()
            }}
          >
            <PiArrowClockwiseDuotone />
          </NormalButton>

          <NormalButton
            className="p-1"
            title={t("features.mods.openOnTheModDB")}
            variant="ghost"
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
            variant="ghost"
            ariaLabel={t("generic.delete")}
            disabled={busy}
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
