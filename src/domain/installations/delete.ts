import type { FileSystem } from "../ports"
import type { BackupRecord } from "./backup"

/** The installation state a delete decision needs, copied out of wherever it lives. */
export interface InstallationDeleteSnapshot {
  path: string
  backups: readonly (Pick<BackupRecord, "path"> & { isDeleting?: boolean })[]
  isPlaying: boolean
  isBackingUp: boolean
  isRestoringBackup: boolean
}

/** Why an installation was not deleted at all. */
export type DeleteInstallationFailure = "installation-playing" | "installation-busy" | "restore-in-progress" | "data-delete-failed"

export type DeleteInstallationResult =
  | {
      ok: true
      /** Backup archive paths that could not be removed. Empty means every file on disk is gone. */
      failedBackupPaths: string[]
    }
  | { ok: false; reason: DeleteInstallationFailure }

export interface DeleteInstallationPorts {
  fileSystem: Pick<FileSystem, "remove">
}

export interface DeleteInstallationInput {
  installation: InstallationDeleteSnapshot
  /** Whether the installation's own data folder and its backup archives are removed too. */
  deleteData: boolean
}

/**
 * Side effects the caller owns: dropping the record, notifications, logging.
 * The service only says when they happen.
 */
export interface DeleteInstallationEvents {
  /** Fired once the installation's own data folder is removed. Only when `deleteData` is true. */
  onDataDeleted?(): void
  /** Fired for each backup archive removed, in order. */
  onBackupDeleted?(path: string): void
  /** Fired for each backup archive that could not be removed, in order. Deletion still continues past it. */
  onBackupDeleteFailed?(path: string): void
}

function refuse(reason: DeleteInstallationFailure): DeleteInstallationResult {
  return { ok: false, reason }
}

/**
 * Drops an installation's data off disk, optionally.
 *
 * When `deleteData` is true the installation's own folder has to go first: if
 * that fails nothing else is touched, because the caller still has a real
 * installation to keep around. Its backup archives are deleted next, one by
 * one, and one failure does not stop the rest: the launcher would rather end
 * up with a few orphaned archives than refuse to drop an installation over a
 * single locked file. Either way, once this returns `ok`, the record is the
 * caller's to drop; a non-empty `failedBackupPaths` just means some archives
 * are still sitting on disk and the caller should say so.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The installation to delete and whether its data should go too.
 * @param events Hooks the caller uses to mirror progress into its own state.
 * @returns Success (with any backup paths still on disk), or the reason nothing was deleted.
 */
export async function deleteInstallation(ports: DeleteInstallationPorts, input: DeleteInstallationInput, events: DeleteInstallationEvents = {}): Promise<DeleteInstallationResult> {
  const { installation, deleteData } = input

  if (installation.isPlaying) return refuse("installation-playing")
  if (installation.isBackingUp) return refuse("installation-busy")
  if (installation.isRestoringBackup) return refuse("restore-in-progress")

  if (!deleteData) return { ok: true, failedBackupPaths: [] }

  if (!(await ports.fileSystem.remove(installation.path))) return refuse("data-delete-failed")
  events.onDataDeleted?.()

  const failedBackupPaths: string[] = []

  for (const backup of installation.backups) {
    // Already on its way out through another operation (a manual delete in
    // flight). Neither this operation's success nor its failure, so it is
    // reported as neither: removing it here would race the same file, and
    // counting it as a failure would be misleading when the other operation
    // is the one that actually succeeds.
    if (backup.isDeleting) continue

    if (await ports.fileSystem.remove(backup.path)) {
      events.onBackupDeleted?.(backup.path)
    } else {
      failedBackupPaths.push(backup.path)
      events.onBackupDeleteFailed?.(backup.path)
    }
  }

  return { ok: true, failedBackupPaths }
}
