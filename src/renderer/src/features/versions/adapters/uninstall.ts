import type { GameVersionSnapshot, UninstallGameVersionFailure, UninstallGameVersionPorts } from "@domain/versions/uninstall"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"

/** Wires the uninstall service onto the renderer. It only needs to remove a folder. */
export function createUninstallPorts(): UninstallGameVersionPorts {
  return { fileSystem: createFileSystemPort() }
}

/** Copies the config-owned version into the plain shape the service reads. */
export function toGameVersionSnapshot(version: GameVersionType): GameVersionSnapshot {
  return {
    version: version.version,
    path: version.path,
    isPlaying: version._playing ?? false,
    isDeleting: version._deleting ?? false,
    linked: version.linked === true
  }
}

/** How many installation names the in-use warning spells out before folding the rest into a count. */
const MAX_LISTED_INSTALLATIONS = 5

/** The installations an in-use warning spells out, and how many more were left off the list. */
export interface UsedByInstallationsSummary {
  /** Installation names to show verbatim, capped at MAX_LISTED_INSTALLATIONS. */
  shown: readonly string[]
  /** Installations left out of `shown`, 0 when none were. Left as a number so the caller can phrase "N more" through i18n instead of this staying English-only. */
  remaining: number
}

/** Splits the installations pinned to a version for the in-use warning. Caps the list so a version shared by dozens of installations doesn't blow up the dialog. */
export function summarizeUsedByInstallations(names: readonly string[]): UsedByInstallationsSummary {
  return { shown: names.slice(0, MAX_LISTED_INSTALLATIONS), remaining: Math.max(0, names.length - MAX_LISTED_INSTALLATIONS) }
}

export interface UninstallFailureFeedback {
  /** i18n key to notify with. */
  messageKey: string
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/** How the UI reacts to a refused uninstall. */
export function describeUninstallFailure(reason: UninstallGameVersionFailure): UninstallFailureFeedback {
  switch (reason) {
    case "version-playing":
      return { messageKey: "features.versions.deleteWhilePlaying", logged: false }
    case "version-in-use":
      // Not a hard failure: ListVersions catches this reason before it gets here
      // and shows the delete-anyway warning instead of a notification. This case
      // only exists so the switch stays exhaustive.
      return { messageKey: "features.versions.versionInUseByInstallations", logged: false }
    case "version-busy":
    case "file-delete-failed":
      return { messageKey: "features.versions.versionUninstallationFailed", logged: true }
  }
}
