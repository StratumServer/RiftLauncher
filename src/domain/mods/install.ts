import type { DownloadOutcome, Downloader, FileSystem, PathBuilder } from "../ports"
import { modsFolder } from "./folder"
import { MOD_DISABLED_SUFFIX } from "./scanInstalled"

/**
 * Extension every mod archive carries on disk.
 *
 * ModDB releases are genuine zips whatever the release file was named on the site, and the game only
 * opens `.zip` inside its Mods folder.
 */
const MOD_ARCHIVE_EXTENSION = ".zip"

/** The release to put on disk, copied out of wherever it lives. */
export interface ModReleaseToInstall {
  /** Where the archive is fetched from. */
  mainfile: string
  /** The `modinfo.json` identifier the release carries. */
  modidstr: string
  /** The version the release publishes, without a leading "v". */
  modversion: string
}

/** The copy already sitting in the Mods folder, the one an install replaces. */
export interface InstalledModCopy {
  /** Full path of the archive on disk. */
  path: string
  /** Version that copy reports, used for the caller's summary rather than for any decision. */
  version: string
}

/**
 * Why a mod was not installed.
 *
 * `old-version-delete-failed` is the one that used to be invisible. The delete result was thrown
 * away and the download ran regardless, so a file the host would not remove left two archives
 * declaring the same modid in one folder. Vintage Story loads both, and which one wins is anybody's
 * guess.
 */
export type InstallModFailure = "installation-busy" | "old-version-delete-failed" | "download-failed"

export type InstallModResult =
  | {
      ok: true
      /** Name the archive was saved under. */
      fileName: string
      /** Where the archive landed. */
      path: string
    }
  | { ok: false; reason: InstallModFailure }

export interface InstallModPorts {
  fileSystem: FileSystem
  paths: PathBuilder
  downloader: Downloader
}

export interface InstallModInput {
  /** The installation folder. The Mods subfolder is appended here, never by the caller. */
  installationPath: string
  release: ModReleaseToInstall
  /** The copy being replaced. Absent for a first install. */
  existing?: InstalledModCopy
  /** True to leave the mod turned off, for a player updating a mod they had disabled. */
  disabled?: boolean
  /** True while a backup or a restore holds the installation's folder. */
  installationBusy?: boolean
}

/**
 * Side effects the caller owns: notifications, table rows, logging. The service only says when they
 * happen.
 */
export interface InstallModEvents {
  /** Fired once the replaced copy is off the disk, before anything is fetched. */
  onExistingRemoved?(path: string): void
  /** Fired when the download is about to start, so a caller can show the mod as working. */
  onDownloadStarted?(fileName: string): void
}

/**
 * The name a release takes on disk: `<modidstr>-<modversion>.zip`.
 *
 * Load-bearing, and not a display concern. The updater finds the copy it is replacing by the path
 * the scan read it from, and the scan reads whatever the folder holds, so two installs of the same
 * mod have to agree on one name or they stack up side by side. It is also what makes an install
 * idempotent: reinstalling the same version overwrites its own file instead of adding a second one.
 *
 * @param disabled True to write the archive named out of the game's way, for updating a mod the
 *   player has turned off. Updating a mod is not a request to turn it back on.
 */
export function modArchiveFileName(release: ModReleaseToInstall, disabled = false): string {
  return `${release.modidstr}-${release.modversion}${MOD_ARCHIVE_EXTENSION}${disabled ? MOD_DISABLED_SUFFIX : ""}`
}

function refuse(reason: InstallModFailure): InstallModResult {
  return { ok: false, reason }
}

/**
 * Puts one mod release in an installation's Mods folder, replacing the copy already there.
 *
 * The replacement is strictly ordered: the old archive goes first, and only a confirmed deletion
 * earns the download. Installing over a copy the host refused to remove is how a Mods folder ends up
 * with two versions of one mod, which is a worse outcome than not updating it at all, so a refused
 * deletion stops this mod and says so.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The release, where it goes, and what it replaces.
 * @param events Hooks the caller uses to mirror progress into its own state.
 * @returns Where the archive landed, or the reason the install stopped.
 */
export async function installMod(ports: InstallModPorts, input: InstallModInput, events: InstallModEvents = {}): Promise<InstallModResult> {
  if (input.installationBusy) return refuse("installation-busy")

  const folder = await modsFolder(ports.paths, input.installationPath)
  const fileName = modArchiveFileName(input.release, input.disabled)

  if (input.existing) {
    if (!(await ports.fileSystem.remove(input.existing.path))) return refuse("old-version-delete-failed")
    events.onExistingRemoved?.(input.existing.path)
  }

  events.onDownloadStarted?.(fileName)

  let downloaded: DownloadOutcome = { ok: false, error: "The downloader never reported an outcome." }
  await ports.downloader.download({ url: input.release.mainfile, outputFolder: folder, fileName }, (reported) => {
    downloaded = reported
  })

  if (!downloaded.ok || !downloaded.filePath) return refuse("download-failed")

  return { ok: true, fileName, path: downloaded.filePath }
}
