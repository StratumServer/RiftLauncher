import type { CloseGuard, ExtractOutcome, Extractor, FileSystem, IdGenerator } from "../ports"
import type { BackupRecord, InstallationSnapshot } from "./backup"

/** Reason handed to the close guard while a restore runs. */
export const RESTORE_CLOSE_GUARD_REASON = "Restoring an installation backup."

/** Suffix of the folder the archive is unpacked into before it takes the installation's place. */
export const RESTORE_STAGING_SUFFIX = "-restoring-"

/** Suffix of the folder the live installation is set aside to while the swap happens. */
export const RESTORE_REPLACED_SUFFIX = "-replaced-"

/**
 * Why a restore did not happen.
 *
 * The three swap reasons say how far the launcher got, because that is the only
 * thing that tells the user where their data is. `extract-failed` and
 * `set-aside-failed` both leave the installation exactly as it was.
 */
export type RestoreInstallationBackupFailure =
  | "installation-busy"
  | "installation-playing"
  | "restore-in-progress"
  | "backup-file-missing"
  | "extract-failed"
  | "set-aside-failed"
  | "swap-failed"
  | "swap-rollback-failed"

export type RestoreInstallationBackupResult =
  | { ok: true }
  | {
      ok: false
      reason: RestoreInstallationBackupFailure
      /** Where the old installation data ended up when the launcher could not put it back. */
      strandedPath: string | null
    }

export interface RestoreInstallationBackupPorts {
  fileSystem: FileSystem
  extractor: Extractor
  ids: IdGenerator
  closeGuard: CloseGuard
}

export interface RestoreInstallationBackupInput {
  installation: InstallationSnapshot
  backup: BackupRecord
}

/**
 * Side effects the caller owns: persisted flags, notifications, logging. The
 * service only says when they happen.
 */
export interface RestoreInstallationBackupEvents {
  /** Fired once the work is committed to, right after the close guard is held. */
  onStarted?(): void
  /** Fired for a temporary folder the launcher could not clean up. Worth a log line, not a failure. */
  onTemporaryFolderLeft?(path: string): void
  /** Fired once the work is over, success or not, after the close guard is released. */
  onFinished?(): void
}

function refuse(reason: RestoreInstallationBackupFailure, strandedPath: string | null = null): RestoreInstallationBackupResult {
  return { ok: false, reason, strandedPath }
}

/** Removes a temporary folder without ever letting the attempt mask the reason we are cleaning up. */
async function discard(ports: RestoreInstallationBackupPorts, events: RestoreInstallationBackupEvents, path: string): Promise<void> {
  try {
    if (await ports.fileSystem.remove(path)) return
  } catch {
    // Cleanup is best effort. The caller already has the outcome that matters.
  }
  events.onTemporaryFolderLeft?.(path)
}

/**
 * Puts an archive back over an installation without ever deleting the live
 * folder first.
 *
 * The archive is unpacked into a temporary sibling folder, the live folder is
 * set aside under a second temporary name, the unpacked folder takes its place,
 * and only then is the set-aside copy deleted. A failed swap rolls the set-aside
 * folder back. The installation is at risk during one move, not during a whole
 * extraction.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The installation snapshot plus the archive to put back.
 * @param events Hooks the caller uses to mirror progress into its own state.
 * @returns Success, or the reason the restore stopped and where the data sits.
 */
export async function restoreInstallationBackup(
  ports: RestoreInstallationBackupPorts,
  input: RestoreInstallationBackupInput,
  events: RestoreInstallationBackupEvents = {}
): Promise<RestoreInstallationBackupResult> {
  const { installation, backup } = input

  if (installation.isBackingUp) return refuse("installation-busy")
  if (installation.isPlaying) return refuse("installation-playing")
  if (installation.isRestoringBackup) return refuse("restore-in-progress")
  if (!(await ports.fileSystem.exists(backup.path))) return refuse("backup-file-missing")

  const token = ports.ids.newId()
  const stagingPath = `${installation.path}${RESTORE_STAGING_SUFFIX}${token}`
  const replacedPath = `${installation.path}${RESTORE_REPLACED_SUFFIX}${token}`

  const release = ports.closeGuard.acquire(RESTORE_CLOSE_GUARD_REASON)
  events.onStarted?.()

  try {
    let outcome: ExtractOutcome = { ok: false, error: "The extractor never reported an outcome." }
    await ports.extractor.extract({ archivePath: backup.path, outputFolder: stagingPath }, (reported) => {
      outcome = reported
    })

    if (!outcome.ok) {
      await discard(ports, events, stagingPath)
      return refuse("extract-failed")
    }

    if (!(await ports.fileSystem.move(installation.path, replacedPath))) {
      await discard(ports, events, stagingPath)
      return refuse("set-aside-failed")
    }

    if (!(await ports.fileSystem.move(stagingPath, installation.path))) {
      // The staging folder is left alone on purpose: a half finished move may
      // have already carried part of it away, and it is the only copy of the
      // archive contents on disk.
      if (!(await ports.fileSystem.move(replacedPath, installation.path))) return refuse("swap-rollback-failed", replacedPath)
      await discard(ports, events, stagingPath)
      return refuse("swap-failed")
    }

    await discard(ports, events, replacedPath)
    return { ok: true }
  } finally {
    release()
    events.onFinished?.()
  }
}
