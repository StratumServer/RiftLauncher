import fse from "fs-extra"

import { getPortableUserDataPaths, isOwnedByThisUser, setUpPortableUserDataFolder, setUpUserDataFolder } from "@src/main/userDataMigration"
import type { PortableUserDataPaths, UserDataSetup } from "@src/main/userDataMigration"

/**
 * Chooses the profile folder before anything else in the process can touch one.
 *
 * `src/main/index.ts` imports this module first on purpose. ESM evaluates every import of the
 * entry before any statement in its body, and electron-log resolves its file path on its first
 * write, so the earliest log call anywhere in the entry's graph fixes the folder for the rest of
 * the run. That is how `app.setPath("userData", ...)` in the body of index.ts came to be too late
 * (#581): a handler module logging at module scope created the default profile, and on Windows that
 * is the very folder the VS Launcher migration probes. Deciding here, before any of those imports
 * run, makes the ordering structural instead of a rule the source has to keep. Nothing in this
 * module's import graph may log at module scope, and tests/main/profileChoice.test.ts guards it.
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
