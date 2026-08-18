import type { DownloadOutcome, Downloader, FileSystem, PathBuilder, UnpackOutcome, Unpacker } from "../ports"
import { folderIsInUse } from "../paths"
import { expectedGameExecutables, toGameOs } from "./gameExecutable"
import type { GameOs } from "./gameExecutable"

/**
 * One platform's build: where it is fetched from, and what the catalog calls it.
 *
 * The file name travels with the URL because the format has to survive the trip
 * to disk. A Linux build is a `.tar.gz` and a Windows build is an `.exe`, and
 * saving either one under a made up name is what broke installs: the extractor
 * routes on the extension and the installer refuses anything that is not `.exe`.
 */
export interface GameVersionDownload {
  /** Where the build is fetched from. Empty when the catalog has no build for the platform. */
  url: string
  /** The name the file is saved under, extension included. Empty when the catalog omits it. */
  fileName: string
}

/** The downloads a catalog entry carries, one per platform the launcher knows. */
export interface GameVersionDownloads {
  win32: GameVersionDownload
  darwin: GameVersionDownload
  linux: GameVersionDownload
}

/** The catalog entry the user picked, copied out of wherever it lives. */
export interface DownloadableGameVersion {
  version: string
  downloads: GameVersionDownloads
}

/**
 * Why a version was not installed.
 *
 * The first three stop before anything is written and before the version is
 * registered. The last three happen with the version already on the list as
 * installing, so the caller has to take it back off.
 */
export type InstallGameVersionFailure = "version-already-installed" | "folder-in-use" | "no-download-for-os" | "download-failed" | "unpack-failed" | "game-executable-missing"

export type InstallGameVersionResult = { ok: true; path: string } | { ok: false; reason: InstallGameVersionFailure }

export interface InstallGameVersionPorts {
  fileSystem: FileSystem
  paths: PathBuilder
  downloader: Downloader
  unpacker: Unpacker
}

export interface InstallGameVersionInput {
  /** Host platform, as the host spells it. Narrowed with {@link toGameOs}. */
  platform: string
  version: DownloadableGameVersion
  /** Folder the version is installed into. */
  targetFolder: string
  /** Version strings the launcher already has, so the same one is not added twice. */
  installedVersions: readonly string[]
  /** Folders the launcher already uses for backups, versions or installations. */
  foldersInUse: readonly string[]
}

/**
 * Side effects the caller owns: persisted state, navigation, notifications. The
 * service only says when they happen.
 */
export interface InstallGameVersionEvents {
  /**
   * Fired once the preconditions pass and the download is about to start, so the
   * caller can show the version as installing before any of the slow work runs.
   */
  onRegistered?(): void
  /** Fired once the game is unpacked and verified in the target folder. */
  onInstalled?(): void
  /**
   * Fired when the install stopped after {@link onRegistered}, so the caller can
   * drop the entry it optimistically added.
   */
  onDiscarded?(reason: InstallGameVersionFailure): void
}

function refuse(reason: InstallGameVersionFailure): InstallGameVersionResult {
  return { ok: false, reason }
}

/**
 * Picks the download for a platform.
 *
 * A build only counts when it has both a URL and a name. A catalog entry
 * missing either one is treated as no build at all rather than guessed at,
 * because a guessed name is exactly what the install cannot survive.
 */
function downloadFor(version: DownloadableGameVersion, os: GameOs): GameVersionDownload | undefined {
  const download = version.downloads[os]
  return download.url && download.fileName ? download : undefined
}

/** True when the target folder holds something the launcher would accept as the game. */
async function gameLanded(ports: InstallGameVersionPorts, targetFolder: string, os: GameOs): Promise<boolean> {
  const candidates = expectedGameExecutables(os)
  // macOS has no expectation to check against, so nothing can be disproved.
  if (candidates.length === 0) return true

  for (const candidate of candidates) {
    const path = await ports.paths.join([targetFolder, candidate])
    if (await ports.fileSystem.exists(path)) return true
  }

  return false
}

/**
 * Downloads one game version and unpacks it into its own folder.
 *
 * Windows ships an Inno Setup installer and everything else ships a portable
 * archive, so the mechanism differs, but the shape does not: download, unpack,
 * then check the game is actually there. That last step is why a silent
 * installer that redirected itself somewhere else is reported as a failure
 * instead of counting as an install.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The picked version, where it goes, and what is already in use.
 * @param events Hooks the caller uses to mirror progress into its own state.
 * @returns The installed folder, or the reason the install stopped.
 */
export async function installGameVersion(ports: InstallGameVersionPorts, input: InstallGameVersionInput, events: InstallGameVersionEvents = {}): Promise<InstallGameVersionResult> {
  const { version, targetFolder } = input
  const os = toGameOs(input.platform)

  if (input.installedVersions.includes(version.version)) return refuse("version-already-installed")
  if (folderIsInUse(targetFolder, input.foldersInUse)) return refuse("folder-in-use")

  const download = downloadFor(version, os)
  if (!download) return refuse("no-download-for-os")

  events.onRegistered?.()

  const discard = (reason: InstallGameVersionFailure): InstallGameVersionResult => {
    events.onDiscarded?.(reason)
    return refuse(reason)
  }

  let downloaded: DownloadOutcome = { ok: false, error: "The downloader never reported an outcome." }
  await ports.downloader.download({ url: download.url, outputFolder: targetFolder, fileName: download.fileName }, (reported) => {
    downloaded = reported
  })

  if (!downloaded.ok || !downloaded.filePath) return discard("download-failed")

  const request = { sourcePath: downloaded.filePath, outputFolder: targetFolder }

  let unpack: UnpackOutcome = { ok: false, error: "The unpacker never reported an outcome." }
  const report = (reported: UnpackOutcome): void => {
    unpack = reported
  }

  // Windows ships an Inno Setup installer, the other platforms ship an archive.
  if (os === "win32") await ports.unpacker.runInstaller(request, report)
  else await ports.unpacker.extractArchive(request, report)

  if (!unpack.ok) return discard("unpack-failed")

  if (!(await gameLanded(ports, targetFolder, os))) return discard("game-executable-missing")

  events.onInstalled?.()
  return { ok: true, path: targetFolder }
}
