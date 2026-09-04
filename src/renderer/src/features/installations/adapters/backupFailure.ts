import type { MakeInstallationBackupFailure } from "@domain/installations/backup"

export interface BackupFailureFeedback {
  /** i18n key to notify with, or null when the launcher stays quiet. */
  messageKey: string | null
  /**
   * The line to write at error level, the reason and its cause already
   * composed, or null when the refusal is expected and does not go to the log.
   */
  logLine: string | null
}

/**
 * The specific reason a compression failed, read off the tail of the wrapped
 * cause `runCompression` threw. Each fragment here is the message a distinct
 * `throw` in `src/ipc/workers/compression.ts` carries, pinned by
 * `tests/ipc/compression.test.ts`. Anything not in this list, including the
 * unsafe-destination and archive-target checks and the raw tar write failure,
 * lands on "the archive could not be written".
 */
const COMPRESS_FAILURE_NOTIFICATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/is too large/, "features.backups.compressSourceTooLarge"],
  [/unsafe filesystem entry/, "features.backups.compressUnsafeEntry"],
  [/Too many filesystem entries/, "features.backups.compressTooManyFiles"]
]

function compressFailureNotificationKey(detail: string | undefined): string {
  for (const [pattern, key] of COMPRESS_FAILURE_NOTIFICATION) {
    if (detail !== undefined && pattern.test(detail)) return key
  }
  return "features.backups.compressWriteFailed"
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
 *
 * `compress-failed` and `prune-failed` each name their cause: the compress
 * side picks a sentence from the failure kind, the prune side names the
 * archive that could not be removed in the log. The raw cause goes to the
 * log for both; the notification stays a plain translated sentence.
 */
export function describeBackupFailure(reason: MakeInstallationBackupFailure, detail?: string): BackupFailureFeedback {
  switch (reason) {
    case "installation-busy":
      return { messageKey: "features.backups.backupInProgress", logLine: null }
    case "installation-playing":
      return { messageKey: "features.backups.backupWhilePlaying", logLine: null }
    case "restore-in-progress":
      return { messageKey: "features.backups.restoreInProgress", logLine: null }
    case "compress-failed":
      return { messageKey: compressFailureNotificationKey(detail), logLine: `Error creating backup: compress-failed${detail ? `. ${detail}` : ""}` }
    case "prune-failed":
      return { messageKey: "features.backups.pruneFailed", logLine: `Error creating backup: prune-failed${detail ? `. Could not remove backup ${detail}` : ""}` }
    case "installation-path-missing":
      return { messageKey: "features.backups.installationPathMissing", logLine: "Error creating backup: installation-path-missing" }
    case "no-backups-folder":
      return { messageKey: "features.backups.noBackupsFolder", logLine: "Error creating backup: no-backups-folder" }
    case "backups-disabled":
      return { messageKey: "features.backups.backupsDisabled", logLine: "Error creating backup: backups-disabled" }
  }
}
