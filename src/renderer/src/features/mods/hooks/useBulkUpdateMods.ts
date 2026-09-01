import { useState } from "react"
import { useTranslation } from "react-i18next"

import { CONFIG_ACTIONS, useConfigDispatch, useSuspendedModUpdates } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useInstallMod } from "@renderer/features/mods/hooks/useInstallMod"
import { logMods } from "@renderer/features/moddb/adapters/log"
import { toInstalledModCopy, toModReleaseToInstall } from "@renderer/features/mods/adapters/install"

const LOG_TAG = "[front] [mods] [features/mods/hooks/useBulkUpdateMods.ts]"

export interface BulkUpdateMods {
  /** Updates every Mod the scan marked updatable, then reports one verdict and opens the summary. */
  updateAllMods: () => Promise<void>
  /** What each attempted update did, ready for the summary table. */
  summaryEntries: ModChangeSummaryEntry[]
  showSummary: boolean
  /** Closes the summary and drops its rows. Callers rescan the folder afterwards. */
  closeSummary: () => void
}

/**
 * Updating every updatable Mod of one Installation in one run.
 *
 * The verdict at the end is the true one, and that is the point of this flow. The version this
 * replaced raised the failure and the success together, out of a catch and a finally, so a bulk
 * update that dropped half the Mods still signed off with "All the Mods were updated successfully".
 */
export function useBulkUpdateMods(installation: InstallationType | undefined, installedMods: InstalledModType[]): BulkUpdateMods {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const configDispatch = useConfigDispatch()
  const suspendedModUpdates = useSuspendedModUpdates()

  const installMod = useInstallMod()

  const [summaryEntries, setSummaryEntries] = useState<ModChangeSummaryEntry[]>([])
  const [showSummary, setShowSummary] = useState(false)

  async function updateAllMods(): Promise<void> {
    if (!installation) return addNotification(t("features.installations.noInstallationFound"), "error")

    if (installation._backuping || installation._restoringBackup) return addNotification(t("features.mods.cantUpdateWhileinUse"), "error")

    const collected: ModChangeSummaryEntry[] = []

    try {
      configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { _updatingMods: true } } })

      // A suspended Mod is held back here and nowhere else: it keeps its update notice, and its own
      // row keeps updating it on demand, which is the whole point of suspending it (#194).
      //
      // A disabled Mod is held back for a different reason (#287): a Mod that is off is not part of
      // what the player is running, and changing its version behind their back means the thing they
      // turn back on later is not the thing they turned off. Its row still updates it on demand.
      const modsToUpdate = installedMods.filter((iMod) => iMod.enabled && iMod._updatableTo && !suspendedModUpdates.includes(iMod.modid))

      await Promise.all(
        modsToUpdate.map(async (modToUpdate) => {
          const release = modToUpdate._mod?.releases.find((candidate) => candidate.modversion === modToUpdate._updatableTo)

          if (!modToUpdate._mod || !release) {
            logMods("error", `${LOG_TAG} [updateAllMods] No ModDB release matching ${modToUpdate._updatableTo} for the ${modToUpdate.name} Mod.`)
            addNotification(t("features.mods.errorUpdatingMod", { mod: modToUpdate.name }), "error")
            collected.push({ name: modToUpdate.name, modid: modToUpdate.modid, fromVersion: modToUpdate.version, toVersion: null, assetid: modToUpdate._mod?.assetid })
            return
          }

          const result = await installMod({
            installationPath: installation.path,
            outName: installation.name,
            modName: modToUpdate._mod.name,
            release: toModReleaseToInstall(release),
            existing: toInstalledModCopy(modToUpdate)
          })

          collected.push({
            name: modToUpdate.name,
            modid: modToUpdate.modid,
            fromVersion: modToUpdate.version,
            toVersion: result.ok ? release.modversion : null,
            assetid: modToUpdate._mod.assetid
          })
        })
      )

      // One verdict, and it is the true one.
      const failed = collected.filter((entry) => entry.toVersion === null).length
      const updated = collected.length - failed

      if (failed === 0) addNotification(t("features.mods.modsUpdatedSuccessfully"), "success")
      else if (updated === 0) addNotification(t("features.mods.errorUpdatingMods"), "error")
      else addNotification(t("features.mods.modsPartiallyUpdated", { updated, failed }), "warning")

      setSummaryEntries(collected)
      setShowSummary(true)
    } catch (err) {
      logMods("error", `${LOG_TAG} [updateAllMods] The Mod update run stopped unexpectedly.`)
      logMods("debug", `${LOG_TAG} [updateAllMods] The Mod update run stopped unexpectedly: ${err}`)
      addNotification(t("features.mods.errorUpdatingMods"), "error")
    } finally {
      configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { _updatingMods: false } } })
    }
  }

  function closeSummary(): void {
    setShowSummary(false)
    setSummaryEntries([])
  }

  return { updateAllMods, summaryEntries, showSummary, closeSummary }
}
