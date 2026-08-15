import { cleanFolderName } from "../naming"
import type { Archiver, Clock, CloseGuard, CompressOutcome, FileSystem, IdGenerator, PathBuilder } from "../ports"

/** Folder the launcher groups installation archives under, inside the backups folder. */
export const INSTALLATIONS_BACKUP_SUBFOLDER = "Installations"

/** Reason handed to the close guard while a backup runs. */
export const BACKUP_CLOSE_GUARD_REASON = "Making and installation backup."

/** One archive already produced for an installation. */
export interface BackupRecord {
  id: string
  date: number
  path: string
}

/** The backup state a decision about one archive needs, copied out of wherever it lives. */
export interface BackupSnapshot {
  id: string
  path: string
  isRestoring: boolean
  isDeleting: boolean
}

/** The installation state a backup decision needs, copied out of wherever it lives. */
export interface InstallationSnapshot {
  id: string
  name: string
  path: string
  backupsLimit: number
  compressionLevel: number
  backups: readonly BackupRecord[]
  isBackingUp: boolean
  isPlaying: boolean
  isRestoringBackup: boolean
}

/**
 * Why a backup did not happen.
 *
 * The last three of the first block used to be one silent no-op that reported
 * success. They are named separately so a caller can tell them apart, even if
 * the current UI still stays quiet for all three.
 */
export type MakeInstallationBackupFailure =
  | "installation-busy"
  | "installation-playing"
  | "restore-in-progress"
  | "installation-path-missing"
  | "no-backups-folder"
  | "backups-disabled"
  | "prune-failed"
  | "compress-failed"

export type MakeInstallationBackupResult = { ok: true; backup: BackupRecord; deletedBackupIds: string[] } | { ok: false; reason: MakeInstallationBackupFailure; deletedBackupIds: string[] }

export interface MakeInstallationBackupPorts {
  fileSystem: FileSystem
  archiver: Archiver
  clock: Clock
  ids: IdGenerator
  paths: PathBuilder
  closeGuard: CloseGuard
}

export interface MakeInstallationBackupInput {
  installation: InstallationSnapshot
  backupsFolder: string
}

/**
 * Side effects the caller owns: persisted flags, notifications, logging. The
 * service only says when they happen.
 */
export interface MakeInstallationBackupEvents {
  /** Fired once the work is committed to, right after the close guard is held. */
  onStarted?(): void
  /** Fired for each pruned archive, in deletion order. */
  onBackupDeleted?(backup: BackupRecord): void
  /** Fired once the work is over, success or not, after the close guard is released. */
  onFinished?(): void
}

function refuse(reason: MakeInstallationBackupFailure, deletedBackupIds: string[] = []): MakeInstallationBackupResult {
  return { ok: false, reason, deletedBackupIds }
}

/**
 * Prunes old archives then compresses an installation into a new one.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The installation snapshot plus the folder archives live in.
 * @param events Hooks the caller uses to mirror progress into its own state.
 * @returns The new record, or the reason nothing was produced.
 */
export async function makeInstallationBackup(ports: MakeInstallationBackupPorts, input: MakeInstallationBackupInput, events: MakeInstallationBackupEvents = {}): Promise<MakeInstallationBackupResult> {
  const { installation, backupsFolder } = input

  if (installation.isBackingUp) return refuse("installation-busy")
  if (installation.isPlaying) return refuse("installation-playing")
  if (installation.isRestoringBackup) return refuse("restore-in-progress")

  if (!(await ports.fileSystem.exists(installation.path))) return refuse("installation-path-missing")
  if (!backupsFolder) return refuse("no-backups-folder")
  if (installation.backupsLimit <= 0) return refuse("backups-disabled")

  const release = ports.closeGuard.acquire(BACKUP_CLOSE_GUARD_REASON)
  events.onStarted?.()

  const deletedBackupIds: string[] = []

  try {
    let remaining = installation.backups.length

    while (remaining > 0 && remaining >= installation.backupsLimit) {
      const oldest = installation.backups[remaining - 1]
      if (!oldest) break

      if (!(await ports.fileSystem.remove(oldest.path))) return refuse("prune-failed", deletedBackupIds)

      deletedBackupIds.push(oldest.id)
      events.onBackupDeleted?.(oldest)
      remaining--
    }

    const date = ports.clock.now()
    const cleanInstallationName = cleanFolderName(installation.name)
    // Yes, toLocaleString on a number: epoch millis with Spanish digit grouping.
    // Kept as is on purpose, changing it would rename every future archive.
    const cleanDate = cleanFolderName(date.toLocaleString("es"))
    const fileName = `${cleanInstallationName}_${cleanDate}.zip`

    const outputFolder = await ports.paths.join([backupsFolder, INSTALLATIONS_BACKUP_SUBFOLDER, cleanInstallationName])
    const archivePath = await ports.paths.join([outputFolder, fileName])

    let outcome: CompressOutcome = { ok: false, error: "The archiver never reported an outcome." }
    await ports.archiver.compress({ sourcePath: installation.path, outputFolder, fileName, compressionLevel: installation.compressionLevel }, (reported) => {
      outcome = reported
    })

    if (!outcome.ok) return refuse("compress-failed", deletedBackupIds)

    return { ok: true, backup: { id: ports.ids.newId(), date, path: archivePath }, deletedBackupIds }
  } finally {
    release()
    events.onFinished?.()
  }
}
