import { installedModsTotal } from "@domain/mods/scanInstalled"
import { CONFIG_ACTIONS, useConfigContext } from "@renderer/features/config/contexts/ConfigContext"

/** What a mod scan came back with, whichever flow ran it. */
export interface ScannedModsCount {
  mods: readonly unknown[]
  errors: readonly unknown[]
}

/**
 * Writes an installation's mod count back into the config after a scan.
 *
 * Every page that lists mods had its own copy of "add the two arrays, dispatch an edit", and they
 * had already started to disagree about whether unreadable archives count. They do.
 */
export function useSyncModsCount(): (installationId: string, scan: ScannedModsCount) => number {
  const { configDispatch } = useConfigContext()

  return function syncModsCount(installationId: string, scan: ScannedModsCount): number {
    const total = installedModsTotal(scan)

    configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installationId, updates: { _modsCount: total } } })

    return total
  }
}
