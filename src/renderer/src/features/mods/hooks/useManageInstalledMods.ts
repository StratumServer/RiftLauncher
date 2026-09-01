import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { useGetCompleteInstalledMods } from "@renderer/features/mods/hooks/useGetCompleteInstalledMods"
import { useSyncModsCount } from "@renderer/features/mods/hooks/useSyncModsCount"

export interface ManageInstalledMods {
  /** Mods the scan could read, ModDB details and update candidates already attached. */
  installedMods: InstalledModType[]
  /** Archives the scan could not read. They still count towards the Installation's Mod total. */
  modsWithErrors: ErrorInstalledModType[]
  /** True while a scan is in flight, for the reload button and the empty state. */
  gettingMods: boolean
  /** Re-runs the scan. Every flow that writes to the Mods folder calls this when it is done. */
  refresh: () => Promise<void>
}

/**
 * One Installation's installed Mods: the scan, what it found, and whether it is still running.
 *
 * The effect keeps its `_updatingMods` dependency on purpose. It is what stops a scan from racing a
 * bulk update that is rewriting the same folder, and it is what runs the scan again the moment that
 * update lets go. It also depends on the Installation's identity and on the config's loaded state:
 * without those, a cold mount whose config arrives after the first render never re-runs the effect,
 * because `_updatingMods` stays `undefined` across that transition, so the scan never starts (#58).
 */
export function useManageInstalledMods(installation: InstallationType | undefined): ManageInstalledMods {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const { schemaVersion } = useSettingsConfig()
  const isConfigLoaded = schemaVersion !== 0

  const getCompleteInstalledMods = useGetCompleteInstalledMods()
  const syncModsCount = useSyncModsCount()

  const [installedMods, setInstalledMods] = useState<InstalledModType[]>([])
  const [modsWithErrors, setModsWithErrors] = useState<ErrorInstalledModType[]>([])

  const [gettingMods, setGettingMods] = useState<boolean>(false)

  useEffect(() => {
    if (!isConfigLoaded) return
    if (!installation?._updatingMods) refresh()
  }, [installation?.id, installation?._updatingMods, isConfigLoaded])

  async function refresh(): Promise<void> {
    if (!installation) return addNotification(t("features.installations.noInstallationSelected"), "error")

    setGettingMods(true)

    const mods = await getCompleteInstalledMods({
      path: installation.path,
      version: installation.version
    })

    syncModsCount(installation.id, mods)

    setInstalledMods(mods.mods)
    setModsWithErrors(mods.errors)
    setGettingMods(false)
  }

  return { installedMods, modsWithErrors, gettingMods, refresh }
}
