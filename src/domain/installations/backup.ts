import { cleanFolderName, formatTimestampForFilename } from "../naming"
import { parentFolder } from "../paths"
import type { Archiver, Clock, CloseGuard, CompressOutcome, FileSystem, IdGenerator, PathBuilder } from "../ports"
import { deleteInstallationBackup } from "./backupDeletion"

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
  backups: readonly (BackupRecord & { isDeleting?: boolean; isRestoring?: boolean })[]
  isBackingUp: boolean
  isPlaying: boolean
  isRestoringBackup: boolean
}

/**
 * Why a backup did not happen.
 *
 * The last three of the first block used to be one silent no-op that reported
 * success. They are named separately so a caller can tell them apart. The
 * renderer now tells the player about all three (see describeBackupFailure
 * in features/installations/adapters/backup.ts), though the auto-backup-
 * before-play flow still treats them as non-blocking, on purpose.
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

export type MakeInstallationBackupResult =
  | { ok: true; backup: BackupRecord; deletedBackupIds: string[] }
  | { ok: false; reason: MakeInstallationBackupFailure; deletedBackupIds: string[]; detail?: string }

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
  /** Fired for each backup dropped: records whose archive was already gone first, then the pruned archives, oldest first. */
  onBackupDeleted?(backup: BackupRecord): void
  /** Fired once the work is over, success or not, after the close guard is released. */
  onFinished?(): void
}

function refuse(reason: MakeInstallationBackupFailure, deletedBackupIds: string[] = [], detail?: string): MakeInstallationBackupResult {
  // The six reasons with nothing to explain keep the shape they always had:
  // `detail` is present only when there is a cause to carry.
  return { ok: false, reason, deletedBackupIds, ...(detail !== undefined ? { detail } : {}) }
}

/** What pruning removed, and whether it got all the way to the limit. */
export type PruneOutcome = { ok: true; deletedBackupIds: string[] } | { ok: false; reason: "prune-failed"; deletedBackupIds: string[]; failedBackupId: string }

/** What is known of one record's archive: it is on disk, it is gone from a folder that is still there, or its folder cannot be reached to say. */
export type ArchiveState = "on-disk" | "gone" | "unreachable"

/**
 * Tells an archive that was deleted from one that cannot be checked.
 *
 * An archive that is not there is only gone when the folder that held it is still
 * there: the file was taken out. A folder that is missing too is a drive that is
 * unplugged, a share that is offline or a Backups folder that moved, and the
 * archives may all be where they were. The same goes for a path the host will not
 * answer about, which is what a Backups folder changed in Config leaves behind.
 * Not knowing is never read as gone.
 */
export async function archiveState(fileSystem: Pick<FileSystem, "exists">, backup: BackupRecord): Promise<ArchiveState> {
  try {
    if (await fileSystem.exists(backup.path)) return "on-disk"

    const folder = parentFolder(backup.path)
    return folder !== undefined && (await fileSystem.exists(folder)) ? "gone" : "unreachable"
  } catch {
    return "unreachable"
  }
}

/**
 * Removes archives from the oldest end until the installation has room for one
 * more under its limit.
 *
 * Only the archives still on disk count. A record whose archive is gone from a
 * folder that is still there comes off first, by the same "already gone counts as
 * deleted" rule deleteInstallationBackup applies: counted with the rest, it would
 * hold a slot and send the walk below onto an archive that is still there (#610).
 * A record whose folder cannot be reached, a drive that is unplugged or a Backups
 * folder that moved, holds no slot either, but it stays as it is: it is never
 * deleted and never reported, so it is still listed when the drive comes back.
 *
 * Archives are held newest first, so the walk runs backwards from the end.
 * Whatever came off is reported either way, since a caller that gives up
 * halfway still has to mirror the deletions that did happen.
 */
export async function pruneOldestBackups(
  fileSystem: Pick<FileSystem, "exists" | "remove">,
  installation: Pick<InstallationSnapshot, "backups" | "backupsLimit">,
  events: MakeInstallationBackupEvents = {}
): Promise<PruneOutcome> {
  const deletedBackupIds: string[] = []

  const states = await Promise.all(installation.backups.map((backup) => archiveState(fileSystem, backup)))
  const archives = installation.backups.filter((_, index) => states[index] === "on-disk")
  for (const backup of installation.backups.filter((_, index) => states[index] === "gone")) {
    deletedBackupIds.push(backup.id)
    events.onBackupDeleted?.(backup)
  }

  let remaining = archives.length

  while (remaining > 0 && remaining >= installation.backupsLimit) {
    const oldest = archives[remaining - 1]
    if (!oldest) break
    remaining--

    const result = await deleteInstallationBackup({ fileSystem }, { backup: { id: oldest.id, path: oldest.path, isDeleting: oldest.isDeleting ?? false, isRestoring: oldest.isRestoring ?? false } })

    // Already on its way out, or in, through another operation (a manual
    // delete or restore in flight). Removing it here too would race the
    // same file; counting it toward `remaining` without touching it is
    // correct either way, since it will not be there (or will still be
    // there, untouched) once that other operation finishes.
    if (!result.ok && result.reason === "backup-in-use") continue

    if (!result.ok) return { ok: false, reason: "prune-failed", deletedBackupIds, failedBackupId: oldest.id }

    deletedBackupIds.push(oldest.id)
    events.onBackupDeleted?.(oldest)
  }

  return { ok: true, deletedBackupIds }
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

  try {
    const pruned = await pruneOldestBackups(ports.fileSystem, installation, events)
    const { deletedBackupIds } = pruned
    if (!pruned.ok) return refuse(pruned.reason, deletedBackupIds, pruned.failedBackupId)

    const date = ports.clock.now()
    // Falls back to a slice of the installation id when the name sanitises
    // away to nothing (e.g. "***"), so the archive never ends up as a bare
    // "_<stamp>.tar.gz".
    const cleanInstallationName = cleanFolderName(installation.name) || installation.id.slice(0, 8)
    const dateStamp = formatTimestampForFilename(date)
    // Backups were zips up to 1.7.0-beta.4 and the restore still reads those, by
    // the extension recorded with each one. New ones are gzipped tar.
    const fileName = `${cleanInstallationName}_${dateStamp}.tar.gz`

    const outputFolder = await ports.paths.join([backupsFolder, INSTALLATIONS_BACKUP_SUBFOLDER, cleanInstallationName])
    const archivePath = await ports.paths.join([outputFolder, fileName])

    let outcome: CompressOutcome = { ok: false, error: "The archiver never reported an outcome." }
    await ports.archiver.compress({ sourcePath: installation.path, outputFolder, fileName, compressionLevel: installation.compressionLevel }, (reported) => {
      outcome = reported
    })

    if (!outcome.ok) return refuse("compress-failed", deletedBackupIds, outcome.error)

    return { ok: true, backup: { id: ports.ids.newId(), date, path: archivePath }, deletedBackupIds }
  } finally {
    release()
    events.onFinished?.()
  }
}
