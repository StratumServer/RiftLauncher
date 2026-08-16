import { useTranslation } from "react-i18next"

import { makeInstallationBackup as runBackup } from "@domain/installations/backup"
import type { MakeInstallationBackupFailure } from "@domain/installations/backup"
import { useConfigContext, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { createBackupPorts, describeBackupFailure, toInstallationSnapshot } from "@renderer/features/installations/adapters/backup"
import { useTaskContext } from "@renderer/contexts/TaskManagerContext"

const LOG_TAG = "[front] [backups] [features/installations/hooks/useMakeInstallationBackup.ts] [useMakeInstallationBackup > makeInstallationBackup]"

/**
 * Reasons that mean "there was nothing to back up", not "backing up broke".
 *
 * MainMenu's auto-backup-before-play reads this hook's return value to decide
 * whether to launch the game at all (`if (!backupMade) return`, before
 * executeGame runs). These three used to be silent and always returned true;
 * they now speak, but they must keep returning true, or turning on automatic
 * backups with, say, an empty Backups folder would silently stop the launcher
 * from ever launching anything. A real failure (compress-failed, prune-failed)
 * still returns false and still blocks the launch, unchanged.
 */
const NON_BLOCKING_REASONS: readonly MakeInstallationBackupFailure[] = ["installation-path-missing", "no-backups-folder", "backups-disabled"]

export function useMakeInstallationBackup(): (installationId: string) => Promise<boolean> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const { config, configDispatch } = useConfigContext()
  const { startCompress } = useTaskContext()

  /**
   * Make a backup of the selected Installation.
   *
   * @param {string} installationId - The ID of the Installation to backup.
   * @returns {Promise<boolean>} - If the backup was made or not.
   */
  async function makeInstallationBackup(installationId: string): Promise<boolean> {
    const installation = config.installations.find((i) => i.id === installationId)

    if (!installation) {
      addNotification(t("features.installations.noInstallationFound"), "error")
      return false
    }

    const setBackuping = (backuping: boolean): void => {
      configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { _backuping: backuping } } })
    }

    const ports = createBackupPorts({
      startCompress,
      taskName: t("features.backups.cmpressTaskName", { name: installation.name }),
      taskDescription: t("features.backups.compressingBackupDescription", { name: installation.name })
    })

    const result = await runBackup(
      ports,
      { installation: toInstallationSnapshot(installation), backupsFolder: config.backupsFolder },
      {
        onStarted: () => setBackuping(true),
        onFinished: () => setBackuping(false),
        onBackupDeleted: (deleted) => {
          configDispatch({ type: CONFIG_ACTIONS.DELETE_INSTALLATION_BACKUP, payload: { id: installation.id, backupId: deleted.id } })
          window.api.utils.logMessage("info", `${LOG_TAG} Deleted old backup ${deleted.path}.`)
        }
      }
    )

    if (result.ok) {
      configDispatch({ type: CONFIG_ACTIONS.ADD_INSTALLATION_BACKUP, payload: { id: installation.id, backup: result.backup } })
      return true
    }

    const { messageKey, logged } = describeBackupFailure(result.reason)

    if (logged) {
      window.api.utils.logMessage("error", `${LOG_TAG} Error creating backup.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Error creating backup: ${result.reason}`)
    }

    if (messageKey) addNotification(t(messageKey), "error")

    return NON_BLOCKING_REASONS.includes(result.reason)
  }

  return makeInstallationBackup
}
