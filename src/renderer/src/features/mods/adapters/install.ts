import type { InstallModFailure, InstallModPorts, InstalledModCopy, ModReleaseToInstall } from "@domain/mods/install"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"
import { createPathBuilderPort } from "@renderer/adapters/paths"
import type { TaskContextType } from "@renderer/contexts/TaskManagerContext"

export interface ModInstallPortsOptions {
  /** The download task runner, straight from TaskManagerContext. */
  startDownload: TaskContextType["startDownload"]
  /** Already translated task name shown in the task list. */
  taskName: string
  /** Already translated description of the download. */
  taskDescription: string
}

/**
 * Wires the mod install service onto the renderer: preload IPC for the file system and paths, the
 * task manager for the download.
 *
 * Built once per mod because the task list names each download after the mod it is fetching.
 */
export function createModInstallPorts({ startDownload, taskName, taskDescription }: ModInstallPortsOptions): InstallModPorts {
  return {
    fileSystem: createFileSystemPort(),
    paths: createPathBuilderPort(),
    downloader: {
      download: (request, onComplete) =>
        startDownload(taskName, taskDescription, "end", request.url, request.outputFolder, request.fileName, (status, path, error) => onComplete({ ok: status, filePath: path, error: error?.message }))
    }
  }
}

/** Copies a ModDB release into the plain shape the service reads. */
export function toModReleaseToInstall(release: DownloadableModReleaseType): ModReleaseToInstall {
  return { mainfile: release.mainfile, modidstr: release.modidstr, modversion: release.modversion }
}

/** Copies an installed mod into the plain shape the service reads. */
export function toInstalledModCopy(mod: InstalledModType): InstalledModCopy {
  return { path: mod.path, version: mod.version }
}

export interface ModInstallFailureFeedback {
  /** i18n key to notify with, or null when the user has already been told. */
  messageKey: string | null
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/**
 * How the UI reacts to a refused install.
 *
 * A failed download says nothing extra: the task manager already raised its own notification when
 * the transfer died, and two toasts for one event read as two problems. A refused deletion is the
 * opposite case, it was silent until now, and it is the one the user can actually do something
 * about.
 */
export function describeModInstallFailure(reason: InstallModFailure): ModInstallFailureFeedback {
  switch (reason) {
    case "installation-busy":
      return { messageKey: "features.mods.cantUpdateWhileinUse", logged: false }
    case "old-version-delete-failed":
      return { messageKey: "features.mods.errorReplacingOldModVersion", logged: true }
    case "download-failed":
      return { messageKey: null, logged: true }
  }
}
