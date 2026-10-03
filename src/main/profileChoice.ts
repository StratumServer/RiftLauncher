import fse from "fs-extra"

import { getPortableUserDataPaths, isOwnedByThisUser, setUpPortableUserDataFolder, setUpUserDataFolder } from "@src/main/userDataMigration"
import type { PortableUserDataPaths, UserDataSetup } from "@src/main/userDataMigration"

/**
 * Chooses the profile folder before anything else in the process can touch one.
 *
 * `src/main/index.ts` imports `bootUserData.ts` first. That module calls this selector before the
 * remaining entry imports are evaluated, so electron-log has not yet resolved a path while profile
 * selection is underway. A handler logging at module scope used to create Electron's default
 * profile before the VS Launcher migration probed it on Windows (#581). The boot-path and
 * module-scope logging tests keep that order and import graph safe.
 */

export interface UserDataSelection {
  readonly setup: UserDataSetup
  readonly portableMode: boolean
  /** A marker sat beside the install folder and was not one this player owns. */
  readonly rejectedMarker: boolean
}

/**
 * Whether a portable marker is an empty regular file belonging to the user running the launcher.
 *
 * `lstat` and not `stat`, so a link planted where the marker is expected does not turn a folder
 * somewhere else into a profile, and size zero so a file with content in it is not a marker either.
 */
export function isTrustedPortableMarker(markerPath: string): boolean {
  let marker: fse.Stats
  try {
    marker = fse.lstatSync(markerPath)
  } catch {
    return false
  }
  return marker.isFile() && marker.size === 0 && isOwnedByThisUser(marker)
}

/**
 * Where a portable marker and its profile would sit for this install, or null when the install
 * cannot carry one.
 *
 * A Linux package install (deb, rpm, pacman) writes a `package-type` marker beside the app, and
 * its parent folder is the system's: a profile there would be written as root on install, shared
 * by every account on the machine, and wiped by the next package upgrade. AppImage runs keep their
 * folder wherever the player put the image, so those are the ones the marker is for.
 */
export function portablePathsForCurrentInstall(
  platform: NodeJS.Platform,
  executablePath: string,
  appImagePath: string | undefined,
  linuxPackageType: string | undefined
): PortableUserDataPaths | null {
  if (platform === "win32") return getPortableUserDataPaths("win32", executablePath, undefined)
  if (platform !== "linux") return null
  if (linuxPackageType !== undefined) return null
  return getPortableUserDataPaths("linux", "", appImagePath)
}

/**
 * Picks the profile folder: the portable one when its marker is trusted, the default one otherwise.
 *
 * Plain data in, plain data out, so the choice is testable without an Electron process;
 * src/main/bootUserData.ts is the half that has to touch `app`.
 */
export function selectUserDataFolder(appDataPath: string, portablePaths: PortableUserDataPaths | null): UserDataSelection {
  if (portablePaths !== null) {
    if (isTrustedPortableMarker(portablePaths.markerPath)) {
      return { setup: setUpPortableUserDataFolder(appDataPath, portablePaths.dataPath, portablePaths.installPath), portableMode: true, rejectedMarker: false }
    }
    if (fse.existsSync(portablePaths.markerPath)) {
      return { setup: setUpUserDataFolder(appDataPath), portableMode: false, rejectedMarker: true }
    }
  }

  return { setup: setUpUserDataFolder(appDataPath), portableMode: false, rejectedMarker: false }
}

/**
 * One sentence for the startup log, so a portable profile and a refused marker both leave a trace
 * instead of the player wondering which folder the launcher picked.
 */
export function describePortableDecision(selection: UserDataSelection): string {
  if (selection.portableMode) return " Running from the portable profile folder."
  if (selection.rejectedMarker) return " Ignored the portable marker beside the install folder: it was not an empty file belonging to this user."
  return ""
}
