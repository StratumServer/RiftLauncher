import type { DeleteInstallationFailure, DeleteInstallationPorts, InstallationDeleteSnapshot } from "@domain/installations/delete"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"

/** Wires the delete service onto the renderer. It only needs to remove paths. */
export function createDeleteInstallationPorts(): DeleteInstallationPorts {
  return { fileSystem: createFileSystemPort() }
}

/** Copies the config-owned installation into the plain shape the service reads. */
export function toInstallationDeleteSnapshot(installation: InstallationType): InstallationDeleteSnapshot {
  return {
    path: installation.path,
    backups: installation.backups.map((backup) => ({ path: backup.path, isDeleting: backup._deleting ?? false })),
    isPlaying: installation._playing ?? false,
    isBackingUp: installation._backuping ?? false,
    isRestoringBackup: installation._restoringBackup ?? false
  }
}

export interface DeleteInstallationFeedback {
  /** i18n key to notify with. */
  messageKey: string
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/** How the UI reacts to a refused deletion. */
export function describeDeleteInstallationFailure(reason: DeleteInstallationFailure): DeleteInstallationFeedback {
  switch (reason) {
    case "installation-playing":
    case "installation-busy":
    case "restore-in-progress":
      return { messageKey: "features.installations.cantDeleteWhileinUse", logged: false }
    case "data-delete-failed":
      return { messageKey: "features.installations.errorDeletingInstallation", logged: true }
  }
}
