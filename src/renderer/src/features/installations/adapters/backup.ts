import { v4 as uuidv4 } from "uuid"

import type { BackupSnapshot, InstallationSnapshot, MakeInstallationBackupFailure, MakeInstallationBackupPorts } from "@domain/installations/backup"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"
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
    fileSystem: createFileSystemPort(),
    archiver: {
      compress: (request, onComplete) =>
        startCompress(
          taskName,
          taskDescription,
          // The hook already raises its own toast via describeBackupFailure
          // for every reason that reaches this compress call, so the generic
          // one would double up. "progress" keeps the ambient start/success
          // toasts and drops only the error.
          "progress",
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

export interface BackupFailureFeedback {
  /** i18n key to notify with, or null when the launcher stays quiet. */
  messageKey: string | null
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/**
 * How the UI reacts to a refusal.
 *
 * The three "nothing to back up" entries (installation-path-missing,
 * no-backups-folder, backups-disabled) were a single silent no-op branch
 * before the service split them apart, and stayed silent for parity with
 * the pre-domain code even after the split. They speak now: each gets its
 * own sentence naming what to do about it. useMakeInstallationBackup still
 * treats them as a non-blocking outcome (see the comment there) because
 * auto-backup-before-play reads this hook's return value to decide whether
 * to launch the game at all, and a missed backup must never refuse to play.
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
      return { messageKey: "features.backups.installationPathMissing", logged: true }
    case "no-backups-folder":
      return { messageKey: "features.backups.noBackupsFolder", logged: true }
    case "backups-disabled":
      return { messageKey: "features.backups.backupsDisabled", logged: true }
  }
}
