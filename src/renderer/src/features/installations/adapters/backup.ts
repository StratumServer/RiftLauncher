import type { BackupSnapshot, InstallationSnapshot, MakeInstallationBackupPorts } from "@domain/installations/backup"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"
import { TASK_NOTIFICATION_POLICIES, type TaskContextType } from "@renderer/contexts/TaskManagerContext"

export interface BackupPortsOptions {
  /** The compress task runner, straight from TaskManagerContext. */
  startCompress: TaskContextType["startCompress"]
  /** Already translated task name shown in the task list. */
  taskName: string
  /** Already translated task description shown in the task list. */
  taskDescription: string
}

/**
 * Wires the backup service onto the renderer: preload IPC for the file system
 * and paths, the task manager for compression, uuid for ids.
 */
export function createBackupPorts({ startCompress, taskName, taskDescription }: BackupPortsOptions): MakeInstallationBackupPorts {
  return {
    fileSystem: createFileSystemPort(),
    archiver: {
      compress: (request, onComplete) =>
        startCompress(
          taskName,
          taskDescription,
          TASK_NOTIFICATION_POLICIES.callerHandled,
          request.sourcePath,
          request.outputFolder,
          request.fileName,
          (status, error) => onComplete({ ok: status, error: error?.message }),
          request.compressionLevel
        )
    },
    clock: { now: () => Date.now() },
    ids: { newId: () => crypto.randomUUID() },
    paths: { join: (parts) => window.api.pathsManager.formatPath(parts) },
    closeGuard: {
      acquire: (reason) => {
        const token = crypto.randomUUID()
        window.api.utils.setPreventAppClose("add", token, reason)
        return () => window.api.utils.setPreventAppClose("remove", token, "Finished installation backup.")
      }
    }
  }
}

/** Copies the config-owned installation into the plain shape the service reads. */
export function toInstallationSnapshot(installation: InstallationType): InstallationSnapshot {
  return {
    id: installation.id,
    name: installation.name,
    path: installation.path,
    backupsLimit: installation.backupsLimit,
    compressionLevel: installation.compressionLevel,
    backups: installation.backups.map((backup) => ({ id: backup.id, date: backup.date, path: backup.path, isDeleting: backup._deleting ?? false, isRestoring: backup._restoring ?? false })),
    isBackingUp: installation._backuping ?? false,
    isPlaying: installation._playing ?? false,
    isRestoringBackup: installation._restoringBackup ?? false
  }
}

/** Copies the config-owned backup into the plain shape the services read. */
export function toBackupSnapshot(backup: BackupType): BackupSnapshot {
  return {
    id: backup.id,
    path: backup.path,
    isRestoring: backup._restoring ?? false,
    isDeleting: backup._deleting ?? false
  }
}

// describeBackupFailure and BackupFailureFeedback moved to ./backupFailure so
// they stay importable from a plain node test: this file also builds the IPC
// ports, which pull in @renderer/adapters and the task manager.
export { describeBackupFailure, type BackupFailureFeedback } from "@renderer/features/installations/adapters/backupFailure"
