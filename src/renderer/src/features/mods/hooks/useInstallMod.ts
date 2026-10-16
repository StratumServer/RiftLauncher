import { useTranslation } from "react-i18next"

import { installMod } from "@domain/mods/install"
import type { InstallModResult, ModReleaseToInstall, InstalledModCopy } from "@domain/mods/install"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { TASK_NOTIFICATION_POLICIES, useTaskContext } from "@renderer/contexts/TaskManagerContext"
import { claimModWrites, modWriteKey, releaseModWrites } from "@renderer/features/mods/hooks/modWrites"
import { createModInstallPorts, describeModInstallFailure } from "@renderer/features/mods/adapters/install"
import { logMods } from "@renderer/features/moddb/adapters/log"

const LOG_TAG = "[front] [mods] [features/mods/hooks/useInstallMod.ts]"

export interface InstallModOptions {
  /** The installation's id, which keys the claim on the Mod being written. */
  installationId: string
  /** The installation folder. Its Mods subfolder is where the archive lands. */
  installationPath: string
  /** Name of the installation, shown in the task list. */
  outName: string
  /** Mod name as the ModDB publishes it, shown in the task list. */
  modName: string
  release: ModReleaseToInstall
  /** The copy this install replaces, absent for a first install. */
  existing?: InstalledModCopy
  /** True to write the archive turned off, for a player updating a Mod they had disabled. */
  disabled?: boolean
  /** True while a backup or a restore holds the installation's folder. */
  installationBusy?: boolean
  /** Aggregate flows keep per-mod feedback in their result table and toast once at the end. */
  feedback?: "individual" | "aggregate"
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
    const { installationId, installationPath, outName, modName, release, existing, disabled, installationBusy, feedback = "individual" } = options

    const labels = { name: modName, version: `v${release.modversion}`, out: outName }

    const ports = createModInstallPorts({
      startDownload,
      taskName: t("features.mods.modTaskName", labels),
      taskDescription: t("features.mods.modDownloadDesc", labels),
      notificationPolicy: feedback === "aggregate" ? TASK_NOTIFICATION_POLICIES.aggregate : TASK_NOTIFICATION_POLICIES.individual
    })

    // Every install of a Mod goes through here, so this is the one place a second install of it is
    // kept out. The old archive stays on disk while the new one downloads; two installs would each
    // delete it, and the second one's take-back would remove the archive the first just installed.
    // Claimed before the first await, so two clicks in one tick cannot both pass.
    const writeKeys = [modWriteKey(installationId, release.modidstr)]
    let result: InstallModResult = { ok: false, reason: "installation-busy" }
    if (claimModWrites(writeKeys)) {
      try {
        result = await installMod(ports, { installationPath, release, existing, disabled, installationBusy })
      } finally {
        releaseModWrites(writeKeys)
      }
    }

    if (result.ok) return result

    const { messageKey, logged } = describeModInstallFailure(result.reason)

    if (logged) {
      logMods("error", `${LOG_TAG} [runInstallMod] Could not install a Mod: ${result.reason}.`)
    }

    if (messageKey && feedback === "individual") addNotification(t(messageKey, { mod: modName }), "error")

    return result
  }
}
