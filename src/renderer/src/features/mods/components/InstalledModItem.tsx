import { useTranslation } from "react-i18next"
import { Input } from "@headlessui/react"
import { PiArrowClockwiseDuotone, PiMoonDuotone, PiMoonFill, PiPowerDuotone, PiPowerFill, PiTrashDuotone } from "react-icons/pi"
import { FiExternalLink } from "react-icons/fi"
import clsx from "clsx"

import { useExternalLinks } from "@renderer/hooks/useExternalLinks"

import { ListItem } from "@renderer/components/ui/List"
import { selectableItemProps } from "@renderer/components/ui/selectableItemProps"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"

/** One installed Mod's row: art, identity, and the enable/suspend/update/ModDB/delete actions. */
function InstalledModItem({
  iMod,
  suspended,
  busy,
  checked,
  distinctName,
  onCheckedChange,
  onToggleEnabledClick,
  onToggleSuspendClick,
  onDeleteClick,
  onUpdateClick,
  detailsOpen = false,
  onToggleDetails,
  detailsButtonRef
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
  /** The row is in the page's selection, which is keyed by this archive's path and nothing else. */
  checked: boolean
  /** The name the checkbox goes by: the Mod's own, plus the file name when another copy shares it. */
  distinctName: string
  onCheckedChange: (checked: boolean) => void
  onToggleEnabledClick: () => void
  onToggleSuspendClick: () => void
  onDeleteClick: () => void
  onUpdateClick: () => void
  /** The details panel is showing this row's Mod. */
  detailsOpen?: boolean
  /** Opens the details panel on this Mod, or closes it when it already shows this one. */
  onToggleDetails?: () => void
  /** The details button, so that closing the panel can hand focus back to it. */
  detailsButtonRef?: (element: HTMLDivElement | null) => void
}>): JSX.Element {
  const { t } = useTranslation()
  const { openOnBrowser: openExternalLink } = useExternalLinks()

  return (
    <ListItem key={iMod.modid + iMod.path}>
      <div
        className={clsx(
          "@container h-20 flex gap-4 p-2 justify-between items-center whitespace-nowrap skip-offscreen-render",
          // Being off wins the tint outright: whatever else the row has to say about updates or
          // suspension, the game is not loading this Mod at all, and that is the headline.
          !iMod.enabled ? "bg-zinc-500/25" : suspended ? "bg-sky-500/25" : iMod._updatableTo ? "bg-lime-600/25" : iMod._lastVersion && "bg-yellow-400/25"
        )}
      >
        <Input
          type="checkbox"
          aria-label={t("features.mods.selectMod", { mod: distinctName })}
          checked={checked}
          disabled={busy}
          onChange={(e) => onCheckedChange(e.target.checked)}
          className="shrink-0 cursor-pointer"
        />

        {/* What describes the Mod is the details button. The actions stay outside it, because nothing
            interactive may sit inside a role=button (#263). */}
        <div
          ref={detailsButtonRef}
          {...selectableItemProps({ onClick: onToggleDetails, pressed: detailsOpen, label: t("features.mods.showModDetails", { mod: iMod.name }) })}
          className={clsx(
            "min-w-0 flex-1 h-full flex gap-4 items-center rounded-sm",
            onToggleDetails && "cursor-pointer focus-visible:outline-2 focus-visible:outline-vsl focus-visible:outline-offset-2"
          )}
        >
          {/* Only what describes the Mod is greyed. The buttons keep their contrast, because the one
            that turns it back on has to stay as readable as every other row's. */}
          <div className={clsx("shrink-0", !iMod.enabled && "opacity-50 grayscale")}>
            {iMod._image ? (
              <img src={`cachemodimg:${iMod._image}`} alt={iMod.name} loading="lazy" className="size-16 @max-md:size-10 object-cover rounded-sm" />
            ) : (
              <div className="size-16 @max-md:size-10 bg-zinc-900 rounded-sm shadow-sm shadow-zinc-950" />
            )}
          </div>

          <ThinSeparator />

          <div className={clsx("min-w-0 w-full flex flex-col gap-1 justify-center overflow-hidden", !iMod.enabled && "opacity-50")}>
            {/* The row's own width, not a floor on the name, is the actual budget (#438): with the
                detail panel (#426) open at the 1024px minimum window this row has no space to spare,
                so below the threshold the thumbnail and the action buttons shrink first, and this
                line wraps so the version drops under the name instead of squeezing it to nothing.

                Two tiers, not one. The panel open at 1280 leaves a 568px row, above @max-md's 448px,
                so none of that fired and a disabled Mod's name was down to 83px with the version and
                the DISABLED badge still beside it. @max-xl (576px) catches that width, and the same
                one at 1024 with the panel closed. Only the name line and the credits answer it: the
                thumbnail, the buttons and the description stay as they are, because at 568px there
                is room for them. gap-y-0 on the wrap keeps the column at the 72px it already is, so
                a row that folds is no taller than one that does not. */}
            <div className="flex gap-2 items-center @max-xl:flex-wrap @max-xl:gap-y-0">
              <p className="min-w-0 truncate font-bold @max-xl:grow">{iMod.name}</p>
              {/* The version (and the disabled label) travel together as one flex item, so wrapping
                    always moves the whole group below the name instead of splitting the "·" from
                    what it separates (#438). */}
              <div className="shrink-0 flex gap-2 items-center">
                <span>·</span>
                <p>v{iMod.version}</p>
                {!iMod.enabled && (
                  <>
                    <span>·</span>
                    <p className="text-sm uppercase tracking-wide text-zinc-300">{t("features.mods.disabledLabel")}</p>
                  </>
                )}
              </div>
            </div>

            {/* Wrapping the name/version line to two rows already spends the height this row has
                  to give (#438); the description and the credits are the lowest-priority lines in
                  this column, so they are what goes rather than clipping the name or the version. */}
            {iMod.description && (
              <div className="overflow-hidden @max-md:hidden">
                <p className="text-sm text-zinc-400 overflow-hidden whitespace-nowrap text-ellipsis">{iMod.description}</p>
              </div>
            )}

            {/* The credits go one tier before the description: of the three lines under the name they
                  are the one a player reads least, and the folded name line needs their height. */}
            <div className="flex gap-2 items-center text-sm text-zinc-400 @max-xl:hidden">
              {iMod.authors && iMod.authors?.length > 0 && (
                <p className="shrink-0 overflow-hidden whitespace-nowrap text-ellipsis">
                  {t("features.mods.authorsLabel")} {iMod.authors?.join(", ")}
                </p>
              )}

              {iMod.authors && iMod.contributors && iMod.authors?.length > 0 && iMod.contributors?.length > 0 && <span>·</span>}

              {iMod.contributors && iMod.contributors?.length > 0 && (
                <p className="overflow-hidden whitespace-nowrap text-ellipsis">
                  {t("features.mods.contributorsLabel")} {iMod.contributors?.join(", ")}
                </p>
              )}
            </div>
          </div>
        </div>

        <ThinSeparator />

        <div className="flex gap-1 justify-end text-lg @max-md:grid @max-md:grid-cols-2">
          <NormalButton title={iMod.enabled ? t("features.mods.disableMod") : t("features.mods.enableMod")} variant="ghost" className="p-1" disabled={busy} onClick={onToggleEnabledClick}>
            {iMod.enabled ? <PiPowerDuotone /> : <PiPowerFill className="text-yellow-400" />}
          </NormalButton>

          <NormalButton className="p-1" title={suspended ? t("features.mods.resumeUpdates") : t("features.mods.suspendUpdates")} variant="ghost" onClick={onToggleSuspendClick}>
            {suspended ? <PiMoonFill className="text-yellow-400" /> : <PiMoonDuotone />}
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

          {/* Only a Mod the ModDB knows has a page there. Without the detail this opened /show/mod/undefined. */}
          {iMod._mod && (
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
          )}

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
