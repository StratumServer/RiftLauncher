import { v4 as uuidv4 } from "uuid"

import type { InstallationSnapshot, MakeInstallationBackupFailure, MakeInstallationBackupPorts } from "@domain/installations/backup"
import type { TaskContextType } from "@renderer/contexts/TaskManagerContext"

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
    fileSystem: {
      exists: (path) => window.api.pathsManager.checkPathExists(path),
      remove: (path) => window.api.pathsManager.deletePath(path)
    },
    archiver: {
      compress: (request, onComplete) =>
        startCompress(
          taskName,
          taskDescription,
          "all",
          request.sourcePath,
          request.outputFolder,
          request.fileName,
          (status, error) => onComplete({ ok: status, error: error?.message }),
          request.compressionLevel
        )
    },
    clock: { now: () => Date.now() },
    ids: { newId: () => uuidv4() },
    paths: { join: (parts) => window.api.pathsManager.formatPath(parts) },
    closeGuard: {
      acquire: (reason) => {
        const token = uuidv4()
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
    backups: installation.backups,
    isBackingUp: installation._backuping ?? false,
    isPlaying: installation._playing ?? false,
    isRestoringBackup: installation._restoringBackup ?? false
  }
}

export interface BackupFailureFeedback {
  /** i18n key to notify with, or null when the launcher stays quiet. */
  messageKey: string | null
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/**
 * How the UI reacts to a refusal.
 *
 * The three silent entries were a single no-op branch before the service split
 * them apart. They still report success and say nothing, on purpose.
 */
export function describeBackupFailure(reason: MakeInstallationBackupFailure): BackupFailureFeedback {
  switch (reason) {
    case "installation-busy":
      return { messageKey: "features.backups.backupInProgress", logged: false }
    case "installation-playing":
      return { messageKey: "features.backups.backupWhilePlaying", logged: false }
    case "restore-in-progress":
      return { messageKey: "features.backups.restoreInProgress", logged: false }
    case "prune-failed":
    case "compress-failed":
      return { messageKey: "features.backups.errorMakingBackup", logged: true }
    case "installation-path-missing":
    case "no-backups-folder":
    case "backups-disabled":
      return { messageKey: null, logged: false }
  }
}
