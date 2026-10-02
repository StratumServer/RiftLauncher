import { app } from "electron"
import { join } from "node:path"

import { setDefaultFolderPathRoot } from "@src/config/configManager"
import { readLinuxPackageType } from "@src/main/linuxPackageType"
import { describePortableDecision, portablePathsForCurrentInstall, selectUserDataFolder } from "@src/main/profileChoice"
import type { UserDataSelection } from "@src/main/profileChoice"
import { getErrorMessage } from "@src/utils/logManager"
import type { UserDataSetup } from "@src/main/userDataMigration"

/**
 * Applies the profile decision to the running app, while this module is being imported.
 *
 * `src/main/index.ts` imports this module first on purpose. ESM evaluates every import of the entry
 * before any statement in its body, and electron-log resolves its file path on its first write, so
 * the earliest log call anywhere in the entry's graph decides where the log folder is for the rest
 * of the run. That is how `app.setPath("userData", ...)` in the body of index.ts came to be too late
 * (#581): a handler module logging at module scope created the default profile, and on Windows that
 * is the very folder the VS Launcher migration probes. Deciding here, before any of those imports
 * run, makes the ordering structural instead of a rule the source has to keep. Nothing in this
 * module's own import graph may log at module scope, and tests/main/profileChoice.test.ts guards it.
 */

/** What the launcher could not do at boot, so the entry can put it on screen once a dialog works. */
export interface BootFailure {
  readonly detail: string
}

/** Holds only Electron's single-instance lock, never a profile. */
const SINGLE_INSTANCE_LOCK_FOLDER = "RiftLauncher.singleton"

const appDataPath = app.getPath("appData")

// Electron derives its single-instance lock from userData, so this path is set before the lock is
// taken and before the profile is chosen. It sits under appData rather than the temp folder so that
// two launches on one machine still exclude each other while scratch profiles stay usable side by
// side, which the headless checks rely on (docs/contribute/headless-checks.md).
app.setPath("userData", join(appDataPath, SINGLE_INSTANCE_LOCK_FOLDER))
if (!app.requestSingleInstanceLock()) process.exit(0)

const portablePaths = portablePathsForCurrentInstall(process.platform, app.getPath("exe"), process.env["APPIMAGE"], process.platform === "linux" ? readLinuxPackageType() : undefined)

let selection: UserDataSelection | null = null
let failure: BootFailure | null = null

try {
  selection = selectUserDataFolder(appDataPath, portablePaths)
  app.setPath("userData", selection.setup.path)
  app.setPath("sessionData", selection.setup.path)
  setDefaultFolderPathRoot(selection.portableMode ? selection.setup.path : appDataPath)
} catch (error) {
  // Without a profile there is nothing else this process can do. userData is still the lock folder,
  // so nothing is written to a folder the player did not choose, and the entry reports it once
  // Electron is ready and a dialog can actually be seen.
  failure = { detail: getErrorMessage(error) }
}

/** The profile the launcher is running on. Only a placeholder while {@link bootFailure} is set. */
export const userDataSetup: UserDataSetup = selection?.setup ?? { path: join(appDataPath, SINGLE_INSTANCE_LOCK_FOLDER), outcome: "fresh", copied: [], cleanedStaleMigration: false }

export const portableMode = selection?.portableMode === true

/** Empty unless the profile came from a portable marker, or one was there and was refused. */
export const portableNote = selection === null ? "" : describePortableDecision(selection)

export const bootFailure = failure
