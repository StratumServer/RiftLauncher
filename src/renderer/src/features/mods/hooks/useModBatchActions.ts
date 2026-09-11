import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { CONFIG_ACTIONS, useConfigDispatch, useSuspendedModUpdates } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { logMods } from "@renderer/features/moddb/adapters/log"
import { createModBatchPorts } from "@renderer/features/moddb/adapters/modsManager"

import { removeMods, setModsEnabled } from "@domain/mods/batch"
import { modsFolderInUse } from "@domain/mods/install"

const LOG_TAG = "[front] [mods] [features/mods/hooks/useModBatchActions.ts]"

export interface ModBatchActions {
  isChecked(path: string): boolean
  setChecked(path: string, checked: boolean): void
  /** Checks every shown Mod, or clears them when every one already is. Checked Mods a filter hides stay as they are. */
  toggleAllShown(): void
  /** The checked Mods among those shown: exactly what the count says and what every action touches. */
  selected: readonly InstalledModType[]
  /** A rename or delete batch is in flight, up to and including the rescan that follows it. */
  running: boolean
  canEnable: boolean
  canDisable: boolean
  canSuspend: boolean
  canResume: boolean
  enable(): Promise<void>
  disable(): Promise<void>
  /** Deletes every selected Mod. Asking first is the caller's job. */
  remove(): Promise<void>
  suspendUpdates(): void
  resumeUpdates(): void
}

/** The distinct modids among `mods`, since suspension is recorded per modid and the reducer does not deduplicate. */
function modidsOf(mods: readonly InstalledModType[]): string[] {
  return [...new Set(mods.map((iMod) => iMod.modid))]
}

/**
 * Manage Mods' selection, and the five things it can do to the selected Mods at once.
 *
 * The selection is keyed by archive path, the only identity two copies of one modid do not share.
 * Every action works on the selection as it stands among `visibleMods`, so a checked Mod that a filter
 * hides is neither counted nor touched (#228): what the player sees is what the buttons act on.
 *
 * Each batch ends in one notification and one rescan, and leaves checked only the Mods that did not go
 * through. Those still sit in the folder under the name they had, so the page itself shows which.
 *
 * @param installation The Installation whose Mods folder the batch writes to.
 * @param installedMods Everything the last scan listed. A checked path it no longer lists is dropped.
 * @param visibleMods What the search and filters leave on screen.
 * @param refresh Rescans the folder, once per batch.
 */
export function useModBatchActions(
  installation: InstallationType | undefined,
  installedMods: readonly InstalledModType[],
  visibleMods: readonly InstalledModType[],
  refresh: () => Promise<void>
): ModBatchActions {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const suspendedModUpdates = useSuspendedModUpdates()
  const configDispatch = useConfigDispatch()

  const [checkedPaths, setCheckedPaths] = useState<ReadonlySet<string>>(() => new Set())

  // The ref is the guard and the state only paints it, as in useInstalledModActions: a second click
  // lands before React has rendered the first one's state.
  const runningRef = useRef(false)
  const [running, setRunning] = useState(false)

  // A Mod that disappears from the folder is forgotten, so one that comes back later does not come
  // back checked.
  useEffect(() => {
    const listed = new Set(installedMods.map((iMod) => iMod.path))
    setCheckedPaths((current) => {
      const kept = [...current].filter((path) => listed.has(path))
      return kept.length === current.size ? current : new Set(kept)
    })
  }, [installedMods])

  const selected = visibleMods.filter((iMod) => checkedPaths.has(iMod.path))
  const toSuspend = modidsOf(selected).filter((modid) => !suspendedModUpdates.includes(modid))
  const toResume = modidsOf(selected).filter((modid) => suspendedModUpdates.includes(modid))

  function setChecked(path: string, checked: boolean): void {
    setCheckedPaths((current) => {
      const next = new Set(current)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function toggleAllShown(): void {
    const shown = visibleMods.map((iMod) => iMod.path)
    setCheckedPaths((current) => {
      const next = new Set(current)
      const everyShownChecked = shown.every((path) => current.has(path))
      for (const path of shown) {
        if (everyShownChecked) next.delete(path)
        else next.add(path)
      }
      return next
    })
  }

  async function renameOrDelete(action: "enable" | "disable" | "delete"): Promise<void> {
    if (!installation) return addNotification(t("features.installations.noInstallationFound"), "error")
    if (modsFolderInUse(installation)) return addNotification(t(action === "delete" ? "features.mods.cantDeleteWhileinUse" : "features.mods.cantToggleWhileinUse"), "error")

    // Only what the action would change is sent: no no-op calls, and the count is what really changed.
    const targets = action === "delete" ? selected : selected.filter((iMod) => iMod.enabled !== (action === "enable"))
    if (targets.length === 0 || runningRef.current) return

    runningRef.current = true
    setRunning(true)

    try {
      const ports = createModBatchPorts()
      const results =
        action === "delete"
          ? await removeMods(
              ports,
              targets.map((iMod) => iMod.path)
            )
          : await setModsEnabled(
              ports,
              targets.map((iMod) => ({ path: iMod.path, enabled: action === "enable" }))
            )

      const failedPaths = results.flatMap((result) => (result.ok ? [] : [result.path]))
      const nameTaken = results.filter((result) => !result.ok && result.reason === "name-taken").length
      const failed = failedPaths.length
      const done = results.length - failed

      logMods("info", `${LOG_TAG} [${action}] Batch ${action}: ${done} changed, ${failed} failed (name-taken ${nameTaken}, refused ${failed - nameTaken}).`)

      if (failed === 0) {
        const message =
          action === "enable"
            ? t("features.mods.modsBatchEnabled", { count: done })
            : action === "disable"
              ? t("features.mods.modsBatchDisabled", { count: done })
              : t("features.mods.modsBatchDeleted", { count: done })
        addNotification(message, "success")
      } else if (done === 0) {
        addNotification(t("features.mods.modsBatchFailed"), "error")
      } else {
        addNotification(t("features.mods.modsBatchPartial", { done, total: results.length, count: failed }), "warning")
      }

      // What went through has a new name or is gone, so the failures are all that is left to hold.
      setCheckedPaths(new Set(failedPaths))
      await refresh()
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }

  /** Suspension lives in the config, keyed by modid, so this touches no archive and needs no rescan. */
  function setSuspended(suspend: boolean): void {
    const modids = suspend ? toSuspend : toResume
    if (modids.length === 0) return

    // React folds these into one render, so the config is saved once.
    for (const modid of modids) {
      configDispatch({ type: suspend ? CONFIG_ACTIONS.ADD_SUSPENDED_MOD_UPDATE : CONFIG_ACTIONS.REMOVE_SUSPENDED_MOD_UPDATE, payload: { modid } })
    }

    logMods("info", `${LOG_TAG} [${suspend ? "suspend" : "resume"}] Batch ${suspend ? "suspend" : "resume"}: ${modids.length} changed.`)
    addNotification(suspend ? t("features.mods.modsBatchSuspended", { count: modids.length }) : t("features.mods.modsBatchResumed", { count: modids.length }), "success")
    setCheckedPaths(new Set())
  }

  return {
    isChecked: (path) => checkedPaths.has(path),
    setChecked,
    toggleAllShown,
    selected,
    running,
    canEnable: selected.some((iMod) => !iMod.enabled),
    canDisable: selected.some((iMod) => iMod.enabled),
    canSuspend: toSuspend.length > 0,
    canResume: toResume.length > 0,
    enable: () => renameOrDelete("enable"),
    disable: () => renameOrDelete("disable"),
    remove: () => renameOrDelete("delete"),
    suspendUpdates: () => setSuspended(true),
    resumeUpdates: () => setSuspended(false)
  }
}
