import type { DownloadableGameVersion, InstallGameVersionFailure, InstallGameVersionPorts } from "@domain/versions/install"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"
import { createPathBuilderPort } from "@renderer/adapters/paths"
import type { TaskContextType } from "@renderer/contexts/TaskManagerContext"

export interface InstallPortsOptions {
  /** The download task runner, straight from TaskManagerContext. */
  startDownload: TaskContextType["startDownload"]
  /** The extract task runner, straight from TaskManagerContext. */
  startExtract: TaskContextType["startExtract"]
  /** The installer task runner, straight from TaskManagerContext. */
  startInstall: TaskContextType["startInstall"]
  /** Already translated task name shown in the task list. */
  taskName: string
  /** Already translated description of the download step. */
  downloadDescription: string
  /** Already translated description of the unpacking step. */
  unpackDescription: string
}

/**
 * Wires the install service onto the renderer: preload IPC for the file system
 * and paths, the task manager for the download and both unpacking mechanisms.
 *
 * Both unpacking runs delete the file they consumed, which is what the flow has
 * always done with the downloaded archive or installer.
 */
export function createInstallPorts({ startDownload, startExtract, startInstall, taskName, downloadDescription, unpackDescription }: InstallPortsOptions): InstallGameVersionPorts {
  return {
    fileSystem: createFileSystemPort(),
    paths: createPathBuilderPort(),
    // "progress": describeInstallFailure already raises a specific toast for every
    // reason download/unpack/install can fail here, so the generic error would double up.
    downloader: {
      download: (request, onComplete) =>
        startDownload(taskName, downloadDescription, "progress", request.url, request.outputFolder, request.fileName, (status, path, error) =>
          onComplete({ ok: status, filePath: path, error: error?.message })
        )
    },
    unpacker: {
      // The Linux game archives carry everything under a single `vintagestory/`
      // folder, which is the one case the extraction steps into. A backup restore
      // asks for the opposite and gets the default.
      extractArchive: (request, onComplete) =>
        startExtract(taskName, unpackDescription, "progress", request.sourcePath, request.outputFolder, true, (status, error) => onComplete({ ok: status, error: error?.message }), true),
      runInstaller: (request, onComplete) =>
        startInstall(taskName, unpackDescription, "progress", request.sourcePath, request.outputFolder, true, (status, error) => onComplete({ ok: status, error: error?.message }))
    }
  }
}

/** Copies the catalog entry into the plain shape the service reads, file names included. */
export function toDownloadableGameVersion(version: DownloadableGameVersionTypeType): DownloadableGameVersion {
  return {
    version: version.version,
    downloads: { win32: version.windows, darwin: version.mac, linux: version.linux }
  }
}

export interface InstallFailureFeedback {
  /** i18n key to notify with. */
  messageKey: string
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/**
 * How the UI reacts to a refused install.
 *
 * Every reason speaks now. The flow used to delete the half-added version and
 * say nothing, so a failed download and an installer that wrote somewhere else
 * looked exactly the same from the version list.
 */
export function describeInstallFailure(reason: InstallGameVersionFailure): InstallFailureFeedback {
  switch (reason) {
    case "version-already-installed":
      return { messageKey: "features.versions.versionAlreadyInstalled", logged: false }
    case "folder-in-use":
      return { messageKey: "features.versions.folderAlreadyInUse", logged: false }
    case "no-download-for-os":
      return { messageKey: "features.versions.noDownloadForYourSystem", logged: false }
    case "download-failed":
      return { messageKey: "features.versions.installDownloadFailed", logged: true }
    case "unpack-failed":
      return { messageKey: "features.versions.installUnpackFailed", logged: true }
    case "game-executable-missing":
      return { messageKey: "features.versions.installGameNotInFolder", logged: true }
  }
}
