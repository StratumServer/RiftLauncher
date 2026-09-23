import type { FileSystem } from "../ports"
import type { BackupSnapshot } from "./backup"

/** Why an archive was not deleted. */
export type DeleteInstallationBackupFailure = "backup-in-use" | "file-delete-failed"

export type DeleteInstallationBackupResult = { ok: true } | { ok: false; reason: DeleteInstallationBackupFailure }

export interface DeleteInstallationBackupPorts {
  fileSystem: Pick<FileSystem, "exists" | "remove">
}

export interface DeleteInstallationBackupInput {
  backup: BackupSnapshot
}

/**
 * Deletes one archive off disk. Dropping it from the installation record is the
 * caller's job, and only once this says the file is gone.
 *
 * A record whose archive is not on disk any more counts as deleted. The host
 * refuses to delete a path it cannot find (assertManagedDeletionPath runs with
 * `allowMissing: false`, see ipc/pathPolicy.ts), so an archive the player
 * removed from the Backups folder by hand used to answer "file-delete-failed"
 * for good: the record could never be dropped, the manual delete kept failing
 * and, once enough records piled up, the prune in makeInstallationBackup
 * refused every new backup (#507). The file is gone either way, which is what
 * the caller asked for.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The archive to delete.
 * @returns Success, or the reason the file is still there.
 */
export async function deleteInstallationBackup(ports: DeleteInstallationBackupPorts, input: DeleteInstallationBackupInput): Promise<DeleteInstallationBackupResult> {
  const { backup } = input

  if (backup.isRestoring || backup.isDeleting) return { ok: false, reason: "backup-in-use" }

  if (!(await ports.fileSystem.remove(backup.path))) {
    if (await ports.fileSystem.exists(backup.path)) return { ok: false, reason: "file-delete-failed" }
  }

  return { ok: true }
}
