import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { newModScanCache, useGetCompleteInstalledMods } from "@renderer/features/mods/hooks/useGetCompleteInstalledMods"
import { useSyncModsCount } from "@renderer/features/mods/hooks/useSyncModsCount"

export interface ManageInstalledMods {
  /** Mods the scan could read, ModDB details and update candidates already attached. */
  installedMods: InstalledModType[]
  /** Archives the scan could not read. They still count towards the Installation's Mod total. */
  modsWithErrors: ErrorInstalledModType[]
  /** True while a scan is in flight, for the reload button and the empty state. */
  gettingMods: boolean
  /**
   * Re-reads the Mods folder. Every flow that writes to it calls this when it is done: the ModDB
   * answers of the last full scan are reused, so it never waits on the network for an id already
   * handled. `full` asks the ModDB again for every Mod, as opening the page and Reload do.
   */
  refresh: (full?: boolean) => Promise<void>
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

  // The last full scan's answers, and which scan they came from. A scan may set the list unless a
  // later-started scan already did, so a Reload still waiting on the ModDB cannot overwrite a later
  // toggle with its older folder read. Answers are adopted only from a scan that started later than
  // the ones already held, so an older full scan landing last cannot replace newer answers.
  const lastScan = useRef(newModScanCache())
  const cachedScan = useRef(0)
  const latestScan = useRef(0)
  const appliedScan = useRef(0)

  useEffect(() => {
    if (!isConfigLoaded) return
    if (!installation?._updatingMods) refresh(true)
  }, [installation?.id, installation?._updatingMods, isConfigLoaded])

  async function refresh(full = false): Promise<void> {
    if (!installation) return addNotification(t("features.installations.noInstallationSelected"), "error")

    setGettingMods(true)
    const scan = ++latestScan.current
    const cache = full ? newModScanCache() : lastScan.current

    const mods = await getCompleteInstalledMods({
      path: installation.path,
      version: installation.version,
      cache
    })

    // Answers do not depend on the Installation: a late full scan's are worth keeping.
    if (full && scan > cachedScan.current) {
      lastScan.current = cache
      cachedScan.current = scan
    }
    if (scan < appliedScan.current) return
    appliedScan.current = scan
    syncModsCount(installation.id, mods)

    setInstalledMods(mods.mods)
    setModsWithErrors(mods.errors)
    if (scan === latestScan.current) setGettingMods(false)
  }

  return { installedMods, modsWithErrors, gettingMods, refresh }
}
