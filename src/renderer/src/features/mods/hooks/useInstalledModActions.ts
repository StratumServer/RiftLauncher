import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { CONFIG_ACTIONS, useConfigDispatch, useSuspendedModUpdates } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { logMods } from "@renderer/features/moddb/adapters/log"
import { setModEnabled } from "@renderer/features/moddb/adapters/modsManager"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"

import { modsFolderInUse } from "@domain/mods/install"

const LOG_TAG = "[front] [mods] [features/mods/hooks/useInstalledModActions.ts]"

export interface InstalledModActions {
  /** Turns one copy on or off, then rescans. A second call on a busy path is dropped. */
  toggleEnabled(copy: InstalledModType): Promise<void>
  /** Adds the modid to, or takes it off, the list Update all skips. */
  toggleSuspended(modid: string): void
  /** Opens the delete confirmation for one copy. Nothing is deleted yet. */
  requestDelete(target: InstalledModType | ErrorInstalledModType): void
  cancelDelete(): void
  /** Deletes the copy the confirmation is open for, by its real path, then rescans. */
  confirmDelete(): Promise<void>
  /** The copy the delete confirmation is open for, or null when it is closed. */
  modToDelete: InstalledModType | ErrorInstalledModType | null
  /** Archive paths with a call in flight, up to and including the rescan that follows it. */
  busyPaths: readonly string[]
  isBusy(path: string): boolean
}

/**
 * The per-Mod actions an Installation's Mods folder offers: enable or disable, suspend updates, and
 * delete. Every page that acts on one installed Mod goes through here, so there is one rename, one
 * double-click guard, one busy-folder refusal and one set of notifications.
 *
 * The callbacks keep their identity across renders: they read the Installation, the refresh and the
 * contexts through a ref, so a memoized row or card handed one of them is not re-rendered for it.
 *
 * @param installation The Installation whose Mods folder the actions write to.
 * @param refresh Rescans that folder. Awaited before a path is released, because a renamed or deleted
 *   archive is a different file from the one the caller is still holding.
 */
export function useInstalledModActions(installation: InstallationType | undefined, refresh: () => Promise<void>): InstalledModActions {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const suspendedModUpdates = useSuspendedModUpdates()
  const configDispatch = useConfigDispatch()

  const [modToDelete, setModToDelete] = useState<InstalledModType | ErrorInstalledModType | null>(null)

  // The ref is the guard and the state is only what paints it. A second click lands before React has
  // rendered anything, so the thing it has to be tested against is written synchronously.
  const busyRef = useRef(new Set<string>())
  const [busyPaths, setBusyPaths] = useState<readonly string[]>([])

  const latest = useRef({ installation, refresh, t, addNotification, suspendedModUpdates, configDispatch, modToDelete })
  useLayoutEffect(() => {
    latest.current = { installation, refresh, t, addNotification, suspendedModUpdates, configDispatch, modToDelete }
  })

  const actions = useMemo(() => {
    function claim(path: string): boolean {
      if (busyRef.current.has(path)) return false
      busyRef.current.add(path)
      setBusyPaths([...busyRef.current])
      return true
    }

    function release(path: string): void {
      busyRef.current.delete(path)
      setBusyPaths([...busyRef.current])
    }

    /**
     * The rescan is not optional and it is not a nicety: the archive's name is its path, so a Mod that
     * just changed state is a different file from the one the caller is holding, and every button
     * acting on it would still be pointing at a name that no longer exists.
     *
     * Which is also why the second of two quick clicks has to be dropped rather than sent: it would
     * carry the name the first one just renamed away, and the player would be told the same action
     * both succeeded and failed.
     */
    async function toggleEnabled(copy: InstalledModType): Promise<void> {
      const { installation, refresh, t, addNotification } = latest.current
      if (!installation) return addNotification(t("features.installations.noInstallationFound"), "error")
      if (modsFolderInUse(installation)) return addNotification(t("features.mods.cantToggleWhileinUse"), "error")
      if (!claim(copy.path)) return

      try {
        const result = await setModEnabled(copy.path, !copy.enabled)

        if (result.ok) {
          addNotification(t(copy.enabled ? "features.mods.modDisabled" : "features.mods.modEnabled", { mod: copy.name }), "success")
        } else {
          logMods("error", `${LOG_TAG} [toggleEnabled] Could not turn a Mod ${copy.enabled ? "off" : "on"}: ${result.reason}.`)
          addNotification(t(result.reason === "name-taken" ? "features.mods.modNameTaken" : "features.mods.errorTogglingMod", { mod: copy.name }), "error")
        }

        await refresh()
      } finally {
        release(copy.path)
      }
    }

    function toggleSuspended(modid: string): void {
      const { suspendedModUpdates, configDispatch } = latest.current
      const suspended = suspendedModUpdates.includes(modid)
      configDispatch({ type: suspended ? CONFIG_ACTIONS.REMOVE_SUSPENDED_MOD_UPDATE : CONFIG_ACTIONS.ADD_SUSPENDED_MOD_UPDATE, payload: { modid } })
    }

    function requestDelete(target: InstalledModType | ErrorInstalledModType): void {
      setModToDelete(target)
    }

    function cancelDelete(): void {
      setModToDelete(null)
    }

    /** The confirmation closes as soon as the host answers; the path stays busy until the rescan is in. */
    async function confirmDelete(): Promise<void> {
      const { installation, refresh, t, addNotification, modToDelete: target } = latest.current
      if (!target) return addNotification(t("features.mods.noModSelected"), "error")
      if (!installation) return addNotification(t("features.installations.noInstallationFound"), "error")
      if (modsFolderInUse(installation)) return addNotification(t("features.mods.cantDeleteWhileinUse"), "error")
      if (!claim(target.path)) return

      try {
        const deleted = await createFileSystemPort()
          .remove(target.path)
          .catch(() => false)
        const refreshed = deleted ? refresh() : undefined

        if (deleted) {
          addNotification(t("features.mods.modSuccessfullyDeleted"), "success")
        } else {
          logMods("error", `${LOG_TAG} [confirmDelete] Could not delete a Mod.`)
          addNotification(t("features.mods.errorDeletingMod"), "error")
        }

        setModToDelete(null)
        await refreshed
      } finally {
        release(target.path)
      }
    }

    return { toggleEnabled, toggleSuspended, requestDelete, cancelDelete, confirmDelete }
  }, [])

  const isBusy = useCallback((path: string): boolean => busyPaths.includes(path), [busyPaths])

  return { ...actions, modToDelete, busyPaths, isBusy }
}
