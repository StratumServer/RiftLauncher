import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { CONFIG_ACTIONS, useConfigDispatch, useSuspendedModUpdates } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { logMods } from "@renderer/features/moddb/adapters/log"
import { setModEnabled } from "@renderer/features/moddb/adapters/modsManager"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"
import { toInstalledModCopy, toModReleaseToInstall } from "@renderer/features/mods/adapters/install"
import { useInstallMod } from "@renderer/features/mods/hooks/useInstallMod"
import { useQueryMod } from "@renderer/features/mods/hooks/useQueryMod"

import { newestCompatibleRelease } from "@domain/mods/compatibility"
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
  /**
   * Replaces one copy with another release of it, then rescans. A disabled copy is replaced by a
   * disabled one: updating a Mod is not a request to turn it back on.
   */
  updateMod(copy: InstalledModType, newRelease: DownloadableModReleaseType): Promise<void>
  /**
   * Installs the newest release tagged for the Installation's game version, then rescans. Resolves
   * to "no-tagged-release", having installed nothing, when no release is tagged for it, so the
   * caller can open the full release list where the player chooses.
   */
  installNewest(mod: DownloadableModOnListType): Promise<"done" | "no-tagged-release">
  /**
   * Archive paths with a call in flight, up to and including the rescan that follows it, plus
   * {@link quickInstallKey} for an install that has no archive yet.
   */
  busyPaths: readonly string[]
  isBusy(path: string): boolean
}

/** The busy key of a Mod being installed from its ModDB listing, before any archive of it exists. */
export function quickInstallKey(modid: number): string {
  return `moddb:${modid}`
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
  const installMod = useInstallMod()
  const queryMod = useQueryMod()

  const [modToDelete, setModToDelete] = useState<InstalledModType | ErrorInstalledModType | null>(null)

  // The ref is the guard and the state is only what paints it. A second click lands before React has
  // rendered anything, so the thing it has to be tested against is written synchronously.
  const busyRef = useRef(new Set<string>())
  const [busyPaths, setBusyPaths] = useState<readonly string[]>([])

  const latest = useRef({ installation, refresh, t, addNotification, suspendedModUpdates, configDispatch, modToDelete, installMod, queryMod })
  useLayoutEffect(() => {
    latest.current = { installation, refresh, t, addNotification, suspendedModUpdates, configDispatch, modToDelete, installMod, queryMod }
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

    /**
     * The download task raises the one notification this makes, success or failure alike;
     * useInstallMod adds one only for the refusals the task never saw.
     */
    async function updateMod(copy: InstalledModType, newRelease: DownloadableModReleaseType): Promise<void> {
      const { installation, refresh, t, addNotification, installMod } = latest.current
      if (!installation) return addNotification(t("features.installations.noInstallationFound"), "error")
      if (modsFolderInUse(installation)) return addNotification(t("features.mods.cantUpdateWhileinUse"), "error")
      if (!claim(copy.path)) return

      try {
        await installMod({
          installationPath: installation.path,
          outName: installation.name,
          modName: copy.name,
          release: toModReleaseToInstall(newRelease),
          existing: toInstalledModCopy(copy),
          disabled: !copy.enabled
        })
        await refresh()
      } finally {
        release(copy.path)
      }
    }

    async function installNewest(mod: DownloadableModOnListType): Promise<"done" | "no-tagged-release"> {
      const { installation, t, addNotification, queryMod } = latest.current
      if (!installation) {
        addNotification(t("features.installations.noInstallationFound"), "error")
        return "done"
      }
      if (modsFolderInUse(installation)) {
        addNotification(t("features.mods.cantUpdateWhileinUse"), "error")
        return "done"
      }
      const key = quickInstallKey(mod.modid)
      if (!claim(key)) return "done"

      try {
        const lookup = await queryMod({ modid: mod.modid })
        if (lookup.status !== "found") {
          addNotification(t("features.mods.versionsLoadFailed"), "error")
          return "done"
        }

        const newest = newestCompatibleRelease(lookup.mod.releases, installation.version)
        if (!newest) return "no-tagged-release"

        // The lookup is a network round trip, long enough for a backup or Update all to have started.
        const { installMod, refresh, installation: current } = latest.current
        await installMod({
          installationPath: installation.path,
          outName: installation.name,
          modName: mod.name,
          release: toModReleaseToInstall(newest),
          installationBusy: current !== undefined && modsFolderInUse(current)
        })
        await refresh()
        return "done"
      } finally {
        release(key)
      }
    }

    return { toggleEnabled, toggleSuspended, requestDelete, cancelDelete, confirmDelete, updateMod, installNewest }
  }, [])

  const isBusy = useCallback((path: string): boolean => busyPaths.includes(path), [busyPaths])

  return { ...actions, modToDelete, busyPaths, isBusy }
}
