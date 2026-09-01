import type { DeleteInstallationBackupFailure, DeleteInstallationBackupPorts } from "@domain/installations/backupDeletion"
import type { RestoreInstallationBackupFailure, RestoreInstallationBackupPorts } from "@domain/installations/restore"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"
import type { TaskContextType } from "@renderer/contexts/TaskManagerContext"

export interface RestorePortsOptions {
  /** The extract task runner, straight from TaskManagerContext. */
  startExtract: TaskContextType["startExtract"]
  /** Already translated task name shown in the task list. */
  taskName: string
  /** Already translated task description shown in the task list. */
  taskDescription: string
}

/**
 * Wires the restore service onto the renderer: preload IPC for the file system,
 * the task manager for extraction, uuid for the temporary folder token.
 */
export function createRestorePorts({ startExtract, taskName, taskDescription }: RestorePortsOptions): RestoreInstallationBackupPorts {
  return {
    fileSystem: createFileSystemPort(),
    extractor: {
      // "progress": the caller already raises its own toast via describeRestoreFailure
      // for every reason this can fail, so the generic error toast would double up.
      extract: (request, onComplete) =>
        startExtract(taskName, taskDescription, "progress", request.archivePath, request.outputFolder, false, (status, error) => onComplete({ ok: status, error: error?.message }))
    },
    ids: { newId: () => crypto.randomUUID() },
    closeGuard: {
      acquire: (reason) => {
        const token = crypto.randomUUID()
        window.api.utils.setPreventAppClose("add", token, reason)
        return () => window.api.utils.setPreventAppClose("remove", token, "Finished backup restoration.")
      }
    }
  }
}

/** Wires the backup deletion service onto the renderer. It only needs to remove a file. */
export function createBackupDeletionPorts(): DeleteInstallationBackupPorts {
  return { fileSystem: createFileSystemPort() }
}

export interface BackupActionFeedback {
  /** i18n key to notify with. */
  messageKey: string
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/**
 * How the UI reacts to a refused restore.
 *
 * Everything that is not a precondition is logged and told to the user, which
 * the old handler never did: a failed restore used to be silent.
 */
export function describeRestoreFailure(reason: RestoreInstallationBackupFailure): BackupActionFeedback {
  switch (reason) {
    case "installation-busy":
      return { messageKey: "features.backups.backupInProgress", logged: false }
    case "installation-playing":
      return { messageKey: "features.installations.editWhilePlaying", logged: false }
    case "restore-in-progress":
      return { messageKey: "features.backups.restoreInProgress", logged: false }
    case "backup-file-missing":
    case "extract-failed":
    case "set-aside-failed":
    case "swap-failed":
      return { messageKey: "features.backups.errorRestoringBackup", logged: true }
    case "swap-rollback-failed":
      return { messageKey: "features.backups.restoreLeftDataAside", logged: true }
  }
}

/** How the UI reacts to a refused deletion. */
export function describeBackupDeletionFailure(reason: DeleteInstallationBackupFailure): BackupActionFeedback {
  switch (reason) {
    case "backup-in-use":
      return { messageKey: "features.backups.cantDeleteWhileinUse", logged: false }
    case "file-delete-failed":
      return { messageKey: "features.backups.errorDeletingBackup", logged: true }
  }
}
