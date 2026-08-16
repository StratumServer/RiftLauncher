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
    case "version-busy":
    case "file-delete-failed":
      return { messageKey: "features.versions.versionUninstallationFailed", logged: true }
  }
}
