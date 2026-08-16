import { useTranslation } from "react-i18next"

import { installMod } from "@domain/mods/install"
import type { InstallModResult, ModReleaseToInstall, InstalledModCopy } from "@domain/mods/install"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useTaskContext } from "@renderer/contexts/TaskManagerContext"
import { createModInstallPorts, describeModInstallFailure } from "@renderer/features/mods/adapters/install"

const LOG_TAG = "[front] [mods] [features/mods/hooks/useInstallMod.ts]"

export interface InstallModOptions {
  /** The installation folder. Its Mods subfolder is where the archive lands. */
  installationPath: string
  /** Name of the installation, shown in the task list. */
  outName: string
  /** Mod name as the ModDB publishes it, shown in the task list. */
  modName: string
  release: ModReleaseToInstall
  /** The copy this install replaces, absent for a first install. */
  existing?: InstalledModCopy
  /** True while a backup or a restore holds the installation's folder. */
  installationBusy?: boolean
}

/**
 * Installs one mod, notifying and logging whatever went wrong.
 *
 * The returned promise settles when the archive is on disk or the attempt has failed, never when the
 * download is merely queued. It used to resolve on enqueue while carrying no result, which is how
 * the bulk updater ended up waiting on a callback that a failed download never fired: one dead
 * download left the whole update spinning with no way out. Callers that do not want to wait can drop
 * the promise, but they can no longer mistake one moment for the other.
 */
export function useInstallMod(): (options: InstallModOptions) => Promise<InstallModResult> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const { startDownload } = useTaskContext()

  return async function runInstallMod(options: InstallModOptions): Promise<InstallModResult> {
    const { installationPath, outName, modName, release, existing, installationBusy } = options

    const labels = { name: modName, version: `v${release.modversion}`, out: outName }

    const ports = createModInstallPorts({
      startDownload,
      taskName: t("features.mods.modTaskName", labels),
      taskDescription: t("features.mods.modDownloadDesc", labels)
    })

    const result = await installMod(ports, { installationPath, release, existing, installationBusy })

    if (result.ok) return result

    const { messageKey, logged } = describeModInstallFailure(result.reason)

    if (logged) {
      window.api.utils.logMessage("error", `${LOG_TAG} [runInstallMod] Could not install the ${modName} Mod on ${outName}.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} [runInstallMod] Could not install ${release.modidstr} v${release.modversion} on ${installationPath}: ${result.reason}.`)
    }

    if (messageKey) addNotification(t(messageKey, { mod: modName }), "error")

    return result
  }
}
