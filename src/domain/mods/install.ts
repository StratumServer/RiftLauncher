import type { DownloadOutcome, Downloader, FileSystem, PathBuilder } from "../ports"
import { refuse } from "../refusal"
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
 * guess. It now means the new archive was fetched, the old one would not go, and the new one was
 * taken back out.
 *
 * `new-version-cleanup-failed` is that same case when the take-back fails too: the folder holds both
 * versions, and the player is the only one who can remove one.
 */
export type InstallModFailure = "installation-busy" | "old-version-delete-failed" | "new-version-cleanup-failed" | "download-failed"

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
 * True while something else is writing the Installation's Mods folder as a whole: a backup, a restore
 * or Update all. Every flow that renames, deletes or downloads a Mod refuses while this holds, so two
 * of them never race on the same archives.
 */
export function modsFolderInUse(installation: Pick<InstallationType, "_backuping" | "_restoringBackup" | "_updatingMods">): boolean {
  return Boolean(installation._backuping || installation._restoringBackup || installation._updatingMods)
}

/**
 * Side effects the caller owns: notifications, table rows, logging. The service only says when they
 * happen.
 */
export interface InstallModEvents {
  /** Fired once the replaced copy is off the disk, which is after the new archive has landed. */
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

/**
 * Removes the archive a new install is replacing, or accepts that an earlier install already did.
 *
 * `DELETE_PATH` refuses a path that does not exist, so a `false` return from `remove` means either
 * the host could not delete the file or the file is already gone. Asking `exists` only after a
 * refused `remove` separates the two without an extra IPC call on every normal update (#735).
 */
async function removeReplacedCopy(fileSystem: FileSystem, path: string): Promise<boolean> {
  return (await fileSystem.remove(path)) || !(await fileSystem.exists(path))
}

/**
 * Puts one mod release in an installation's Mods folder, replacing the copy already there.
 *
 * The new archive is fetched first and the old one goes only once the new one is on disk, so a
 * download that fails or times out leaves the installed mod exactly as it was. The old order,
 * delete then download, lost the mod whenever the download died, and Update all started every
 * deletion within milliseconds while the downloads waited in a queue.
 *
 * The folder still never keeps two versions of one mod. When the old archive then refuses to go, the
 * new one is taken back out and the install stops, since two archives of one modid are worse than
 * not updating. Two cases differ from that order:
 * - The new archive lands on the old one's own path (same version, same state): the download's
 *   rename already replaced it, and deleting afterwards would delete the new file.
 * - The two paths differ only by letter case: on a case-insensitive volume they are one file, so
 *   the download would replace it and a delete after it would remove the new archive. That case
 *   keeps the old order, delete first.
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
  const { existing } = input

  // A case-only match is one file on a case-insensitive volume. On the others it is two names of one
  // version, and deleting the old one first is no worse than the order it replaces.
  const target = await ports.paths.join([folder, fileName])
  const sameFileOnDisk = existing !== undefined && existing.path !== target && existing.path.toLowerCase() === target.toLowerCase()

  if (existing && sameFileOnDisk) {
    if (!(await removeReplacedCopy(ports.fileSystem, existing.path))) return refuse("old-version-delete-failed")
    events.onExistingRemoved?.(existing.path)
  }

  events.onDownloadStarted?.(fileName)

  let downloaded: DownloadOutcome = { ok: false, error: "The downloader never reported an outcome." }
  await ports.downloader.download({ url: input.release.mainfile, outputFolder: folder, fileName }, (reported) => {
    downloaded = reported
  })

  if (!downloaded.ok || !downloaded.filePath) return refuse("download-failed")

  // Judged against where the download says it landed, the form the scan reads paths in, rather than
  // against the path joined here: a spelling that differs while naming the same file would otherwise
  // delete the archive that was just written.
  if (existing && !sameFileOnDisk && existing.path !== downloaded.filePath) {
    if (!(await removeReplacedCopy(ports.fileSystem, existing.path))) {
      // Taken back out so the folder does not end up with both versions.
      if (!(await ports.fileSystem.remove(downloaded.filePath))) return refuse("new-version-cleanup-failed")
      return refuse("old-version-delete-failed")
    }
    events.onExistingRemoved?.(existing.path)
  }

  return { ok: true, fileName, path: downloaded.filePath }
}
