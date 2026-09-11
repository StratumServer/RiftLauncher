import { memo, useLayoutEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import {
  PiArrowCircleUpDuotone,
  PiChatCenteredTextDuotone,
  PiDownloadDuotone,
  PiDownloadSimpleDuotone,
  PiMoonDuotone,
  PiMoonFill,
  PiPowerDuotone,
  PiPowerFill,
  PiStarDuotone,
  PiStarFill,
  PiTrashDuotone,
  PiUserCircleDuotone
} from "react-icons/pi"
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

/** What a card's action strip asks for. The page works out which installed copy that means. */
export type ModCardAction = "install" | "update" | "toggle-enabled" | "toggle-suspended" | "delete"

/**
 * How the selected Installation holds a Mod: one copy, on or off, or several. A card never picks
 * between several copies; which file the player meant is theirs to say, in Manage Mods.
 */
export type ModCopyState = "enabled" | "disabled" | "several"

/**
 * One Mod in the ModDB grid: art, favorite/ModDB actions, its stats and, when an Installation is
 * selected, the actions on that Installation's copy of it.
 *
 * Memoized because the grid can hold hundreds of these: onSelect/onToggleFav/onOpenModDb
 * take the mod as an argument instead of being pre-bound per card, so ModsGrid can hand
 * every card the same stable callback reference and let memo actually skip cards untouched
 * by whatever caused the grid to re-render. The same goes for the action props: primitives and
 * one onAction, so a rescan that hands the page new copy objects re-renders only the cards whose
 * state actually moved.
 */
function ModListCard({
  mod,
  installed,
  isFav,
  onSelect,
  onToggleFav,
  onOpenModDb,
  installationId,
  copyState,
  suspended = false,
  busy = false,
  updateTo,
  onAction
}: Readonly<{
  mod: DownloadableModOnListType
  installed: boolean
  isFav: boolean
  onSelect: (mod: DownloadableModOnListType) => void
  onToggleFav: (mod: DownloadableModOnListType) => void
  onOpenModDb: (mod: DownloadableModOnListType) => void
  /** The selected Installation. Without one there is nothing to act on, so the card shows no actions. */
  installationId?: string
  /** Set when the Mod is installed in the selected Installation. */
  copyState?: ModCopyState
  /** Update all skips this Mod. */
  suspended?: boolean
  /** An action on this Mod is in flight, up to and including the rescan that follows it. */
  busy?: boolean
  /** A newer release tagged for the Installation's game version, once the ModDB details are in. */
  updateTo?: string
  onAction?: (mod: DownloadableModOnListType, action: ModCardAction) => void | Promise<unknown>
}>): JSX.Element {
  const { t } = useTranslation()
  const disabled = copyState === "disabled"

  const cardRef = useRef<HTMLDivElement>(null)
  const actionsHadFocus = useRef(false)

  // An action can take away the very button that has focus: Update once the new release is in,
  // Install once the Mod is. Focus then falls to the page body and a keyboard player has to start
  // over from the top, so it is put back on this card instead.
  useLayoutEffect(() => {
    if (!actionsHadFocus.current || (document.activeElement !== null && document.activeElement !== document.body)) return
    actionsHadFocus.current = false
    cardRef.current?.focus()
  })

  const action = (kind: ModCardAction) => (): void | Promise<unknown> => onAction?.(mod, kind)

  return (
    <GridItem selected={installed} size="w-[18rem] max-w-[26rem]" className="group relative overflow-hidden">
      <div
        ref={cardRef}
        {...selectableItemProps({
          onClick: () => onSelect(mod),
          label: [mod.name, t(installed ? "generic.installed" : "generic.notInstalled"), ...(disabled ? [t("features.mods.disabledLabel")] : [])].join(", ")
        })}
        className="w-full cursor-pointer focus-visible:outline-2 focus-visible:outline-vsl focus-visible:outline-offset-2"
      >
        <div className="relative w-full aspect-[3/2] skip-offscreen-render">
          <img
            src={mod.logo ? `${mod.logo}` : "https://mods.vintagestory.at/web/img/mod-default.png"}
            alt={mod.name}
            loading="lazy"
            className={clsx("w-full h-full object-cover object-top", disabled && "opacity-50 grayscale")}
          />
          {disabled && <span className="absolute bottom-1 left-1 rounded-sm px-1 bg-zinc-950/80 text-xs uppercase tracking-wide text-zinc-200">{t("features.mods.disabledLabel")}</span>}
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
        {/*
         * The favorite hue goes on the icon: a colour on the ghost FormButton loses the cascade
         * to the variant's own `text-zinc-200` and never paints (issue #414). The solid star and
         * the always-on `bg-zinc-950` pill are both load-bearing: the star floats over a mod logo
         * the launcher does not control, and a yellow icon alone reads about 1.6:1 on a bright
         * one. The pill is set in the hover state too so the button's own hover fill cannot
         * replace it. A non-favorite star stays hidden until the card is hovered.
         */}
        <FormButton
          title={t("generic.favorite")}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFav(mod)
          }}
          variant="ghost"
          ariaPressed={isFav}
          className={clsx("p-1 text-lg bg-zinc-950/60 hover:bg-zinc-950/70", !isFav && "opacity-0 group-hover:opacity-100 duration-200")}
        >
          {isFav ? <PiStarFill className="text-yellow-400" /> : <PiStarDuotone />}
        </FormButton>

        <FormButton
          title={t("features.mods.openOnTheModDB")}
          onClick={(e) => {
            e.stopPropagation()
            onOpenModDb(mod)
          }}
          variant="ghost"
          className="p-1 text-lg opacity-0 group-hover:opacity-100 duration-200"
        >
          <FiExternalLink />
        </FormButton>
      </div>

      {/*
       * A sibling of the card's role=button, never inside it: a control nested in a button is
       * invalid and was taken out on purpose (#263). Icon-only, with the icon as children, so the
       * titles are tooltips and accessible names rather than visible labels. Both toggles keep one
       * title and let aria-pressed carry the state, like the favorite star.
       */}
      {installationId !== undefined && (
        <div
          role="group"
          aria-label={mod.name}
          onFocus={() => (actionsHadFocus.current = true)}
          // A null relatedTarget is focus going nowhere, which is what a button being taken away
          // looks like; anywhere else is the player moving on.
          onBlur={(event) => event.relatedTarget && (actionsHadFocus.current = false)}
          className="flex items-center justify-end gap-1 px-2 pb-1 text-lg"
        >
          {!installed ? (
            <FormButton title={t("features.mods.quickInstall")} variant="ghost" className="p-1" disabled={busy} onClick={action("install")}>
              <PiDownloadSimpleDuotone />
            </FormButton>
          ) : copyState === "several" ? (
            <p className="w-full text-xs text-zinc-400">
              {t("features.mods.severalCopiesInstalled")}{" "}
              <Link to={`/installations/mods/${installationId}`} className="underline text-zinc-200">
                {t("features.mods.manageMods")}
              </Link>
            </p>
          ) : (
            copyState && (
              <>
                {updateTo && (
                  <FormButton title={t("features.mods.updateToVersion", { version: updateTo })} variant="ghost" className="p-1" disabled={busy} onClick={action("update")}>
                    <PiArrowCircleUpDuotone />
                  </FormButton>
                )}
                <FormButton title={t("features.mods.enabledToggle")} variant="ghost" className="p-1" ariaPressed={!disabled} disabled={busy} onClick={action("toggle-enabled")}>
                  {disabled ? <PiPowerFill className="text-yellow-400" /> : <PiPowerDuotone />}
                </FormButton>
                <FormButton title={t("features.mods.updatesSuspendedToggle")} variant="ghost" className="p-1" ariaPressed={suspended} onClick={action("toggle-suspended")}>
                  {suspended ? <PiMoonFill className="text-yellow-400" /> : <PiMoonDuotone />}
                </FormButton>
                <FormButton
                  title={t("generic.delete")}
                  variant="ghost"
                  className="p-1"
                  disabled={busy}
                  onClick={() => {
                    // The confirmation hands focus back to whatever had it when it opened, and the
                    // rescan after a delete takes this button away, sometimes before the dialog has
                    // finished closing. The card outlives both, so it is what the dialog returns to.
                    cardRef.current?.focus()
                    return onAction?.(mod, "delete")
                  }}
                >
                  <PiTrashDuotone />
                </FormButton>
              </>
            )
          )}
        </div>
      )}
    </GridItem>
  )
}

export default memo(ModListCard)
