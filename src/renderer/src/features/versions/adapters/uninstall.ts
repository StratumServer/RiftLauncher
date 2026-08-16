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
    isDeleting: version._deleting ?? false
  }
}

/** How many installation names the in-use warning spells out before folding the rest into "and N more". */
const MAX_LISTED_INSTALLATIONS = 5

/** Names the installations pinned to a version, for the in-use warning. Caps the list so a version shared by dozens of installations doesn't blow up the dialog. */
export function formatUsedByInstallations(names: readonly string[]): string {
  if (names.length <= MAX_LISTED_INSTALLATIONS) return names.join(", ")

  const shown = names.slice(0, MAX_LISTED_INSTALLATIONS)
  const remaining = names.length - MAX_LISTED_INSTALLATIONS

  return `${shown.join(", ")} and ${remaining} more`
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
