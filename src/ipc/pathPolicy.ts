import { app } from "electron"
import fse from "fs-extra"
import { basename, dirname, join, resolve } from "node:path"

import { getConfig } from "@src/config/configManager"
import { MODS_FOLDER_NAME } from "@domain/mods/folder"
import type { PathGrant } from "@src/ipc/validation"
import { assertNonRootPath, assertNoSymlinkComponents, comparablePath, isPathGranted, isPathWithin, isRestoreWorkspaceName } from "@src/ipc/validation"

type ApprovedPath = PathGrant & {
  expiresAt: number
}

type PathPolicyOptions = {
  allowMissing?: boolean
  allowApprovedSelection?: boolean
  /**
   * Skips the symlink walk, for read-only channels only (#237).
   *
   * The grant check is lexical, and the symlink walk is what keeps it
   * honest: without it a link inside a granted subtree points wherever it likes
   * and the lexical answer stops matching the real one. Every channel that
   * writes, deletes or replaces therefore keeps the walk, so a caller cannot
   * reach past the grant with a link. Reading is the case where the mismatch is
   * the user's own doing and their prerogative: people link a Mods folder at a
   * game install they keep in the default Vintage Story location, or on another
   * disk, and the launcher refusing to list it is the bug.
   */
  allowSymlinks?: boolean
  /**
   * Set by a delete, never by a move: the backups and world backups of the Installation whose
   * folder is the path are not counted as held, because they leave with it (#733).
   */
  ownArchivesLeave?: boolean
}

const approvedPaths: ApprovedPath[] = []
const APPROVAL_TTL_MS = 10 * 60 * 1_000

function pruneApprovals(): void {
  const now = Date.now()
  for (let index = approvedPaths.length - 1; index >= 0; index--) {
    const approved = approvedPaths[index]
    if (approved && approved.expiresAt <= now) approvedPaths.splice(index, 1)
  }
}

/**
 * Records what the user just picked in a native dialog, for ten minutes.
 *
 * A folder grants its subtree, since that is where the launcher will put an
 * installation or a game version. Anything else grants the one path: a file the
 * open dialog returned, or a file the save dialog named and that therefore does
 * not exist yet.
 */
export function registerUserSelectedPaths(paths: readonly string[]): void {
  pruneApprovals()
  for (const pathValue of paths) {
    const selectedPath = resolve(assertNonRootPath(pathValue))
    let descendants = false

    try {
      descendants = fse.lstatSync(selectedPath).isDirectory()
    } catch {
      descendants = false
    }

    const existing = approvedPaths.find((approved) => comparablePath(approved.path) === comparablePath(selectedPath))
    if (existing) {
      existing.descendants = existing.descendants || descendants
      existing.expiresAt = Date.now() + APPROVAL_TTL_MS
    } else {
      approvedPaths.push({ path: selectedPath, descendants, expiresAt: Date.now() + APPROVAL_TTL_MS })
    }
  }
}

export function isUserApprovedPath(pathValue: string): boolean {
  pruneApprovals()
  return isPathGranted(approvedPaths, pathValue)
}

function toGrants(paths: readonly (string | undefined)[], descendants: boolean): PathGrant[] {
  return paths.filter((pathValue): pathValue is string => typeof pathValue === "string" && pathValue.length > 0).map((pathValue) => ({ path: pathValue, descendants }))
}

/** The three folders the user points the launcher at. Everything under them is managed. */
function getConfiguredFolders(config: ConfigType): string[] {
  return [config.defaultInstallationsFolder, config.defaultVersionsFolder, config.backupsFolder]
}

/** The folders the launcher writes to inside its own user data folder. */
function getLauncherFolders(): string[] {
  return [resolve(app.getPath("userData"), "Logs"), resolve(app.getPath("userData"), "Cache"), resolve(app.getPath("userData"), "Icons"), resolve(app.getPath("userData"), "Sessions")]
}

/**
 * The individual entries the config names, as opposed to the folders they
 * usually live in.
 *
 * Installations and game versions grant their subtree: the launcher reads and
 * writes mods, saves, client settings and game files under them, and an
 * installation the user put outside every configured folder still has to work.
 * A backup grants its own path only. Every archive the launcher makes is a
 * single file, a `.tar.gz` now and a `.zip` for the ones written before
 * 1.7.0-beta.4 (see makeInstallationBackup), so a path *under* one is never a
 * path the launcher meant to reach.
 */
function getEntryGrants(config: ConfigType): PathGrant[] {
  return [
    ...toGrants(
      config.installations.map((installation) => installation.path),
      true
    ),
    ...toGrants(
      config.gameVersions.map((gameVersion) => gameVersion.path),
      true
    ),
    ...toGrants(
      config.installations.flatMap((installation) => installation.backups.map((backup) => backup.path)),
      false
    ),
    ...toGrants(
      config.installations.flatMap((installation) => (installation.worldBackups ?? []).map((backup) => backup.path)),
      false
    )
  ]
}

/** What `assertManagedPath` admits: the managed folders plus the entries the config names. */
function getManagedPathGrants(config: ConfigType): PathGrant[] {
  return [...toGrants([...getConfiguredFolders(config), ...getLauncherFolders()], true), ...getEntryGrants(config)]
}

/**
 * What a *saved config* may declare an installation, game version or backup
 * under, without the user having picked the place in a native dialog first.
 *
 * Narrower than `getManagedPathGrants` by the launcher's own folders: Logs,
 * Cache and Icons are places the launcher writes, never places game data is
 * declared to live, and leaving them in let a config save move an installation
 * into them with no dialog at all.
 */
function getConfigDeclarationGrants(config: ConfigType): PathGrant[] {
  return [...toGrants(getConfiguredFolders(config), true), ...getEntryGrants(config)]
}

/**
 * The backup restore stages the archive next to the installation and sets the
 * live folder aside beside it, so both temporary folders are siblings of a
 * managed installation rather than children of a configured root. They are
 * admitted by name only, and the name carries the installation folder name plus
 * a generated token, so nothing that already exists on disk can be reached.
 */
function isRestoreWorkspaceOf(installationPath: string, candidate: string): boolean {
  const root = comparablePath(installationPath)
  const target = comparablePath(candidate)
  return dirname(root) === dirname(target) && isRestoreWorkspaceName(basename(root), basename(target))
}

function realPathOrSelf(path: string): string {
  try {
    return fse.realpathSync(path)
  } catch {
    return path
  }
}

function getProtectedPaths(config: ConfigType): string[] {
  return [app.getPath("userData"), app.getPath("appData"), app.getPath("home"), app.getAppPath(), ...getConfiguredFolders(config), ...getLauncherFolders()]
}

export async function assertManagedPath(value: unknown, name = "path", options: PathPolicyOptions = {}): Promise<string> {
  const pathValue = resolve(assertNonRootPath(value, name))
  const config = await getConfig()
  const isConfiguredPath = isPathGranted(getManagedPathGrants(config), pathValue)
  const isApprovedPath = options.allowApprovedSelection !== false && isUserApprovedPath(pathValue)
  const isRestoreWorkspace = config.installations.some((installation) => isRestoreWorkspaceOf(installation.path, pathValue))
  if (!isConfiguredPath && !isApprovedPath && !isRestoreWorkspace) throw new TypeError(`Unmanaged ${name}`)

  if (!options.allowMissing && !fse.existsSync(pathValue)) throw new TypeError(`Missing ${name}`)
  if (!options.allowSymlinks) assertNoSymlinkComponents(pathValue, "Symbolic links are not allowed for managed paths")
  return pathValue
}

/**
 * @param options Left empty by most callers. `assertManagedModArchivePath` passes the relaxed walk
 *   (`allowSymlinks`) and pays for it with a check of its own; DELETE_PATH passes `ownArchivesLeave`,
 *   because a delete of an Installation's folder takes its own archives and their records with it.
 */
export async function assertManagedDeletionPath(value: unknown, options: PathPolicyOptions = {}): Promise<string> {
  const config = await getConfig()
  const pathValue = await assertManagedPath(value, "deletion path", { allowMissing: false, ...options })
  if (getProtectedPaths(config).some((protectedPath) => comparablePath(protectedPath) === comparablePath(pathValue))) throw new TypeError("Protected path")
  // Removing or moving a folder takes everything under it. The protected folders, the other
  // Installations and game versions the config names, and the backup archives it lists must not be
  // under the path, so a restore or a delete of an Installation that holds one (a config from
  // before nesting was refused) stops before anything moves. The archives count wherever the Backups
  // folder is set now: moving that setting leaves the archives already made where they were. The
  // path was vetted without symbolic links, but a managed folder can be reached through one, so each
  // is compared where it really lives as well.
  const entryPaths = [...config.installations, ...config.gameVersions].map((entry) => entry.path)
  // A delete of an Installation's folder takes its own archives and their records with it, so those
  // are not held. A move of that folder (the set-aside of a restore) keeps the records, so it counts them.
  const archivePaths = config.installations
    .filter((installation) => !(options.ownArchivesLeave && comparablePath(installation.path) === comparablePath(pathValue)))
    .flatMap((installation) => [...installation.backups, ...(installation.worldBackups ?? [])].map((backup) => backup.path))
  // Two entries on one folder (a config from before case or equal paths were refused) are wiped together.
  if (entryPaths.filter((entryPath) => comparablePath(entryPath) === comparablePath(pathValue)).length > 1) throw new TypeError("Path is shared by managed entries")
  for (const nestedPath of [...getProtectedPaths(config), ...entryPaths, ...archivePaths]) {
    const isTarget = comparablePath(nestedPath) === comparablePath(pathValue)
    if (isPathWithin(pathValue, nestedPath, false) || (!isTarget && isPathWithin(pathValue, realPathOrSelf(nestedPath), true))) throw new TypeError("Path holds a managed folder")
  }
  return pathValue
}

/**
 * A mod archive the launcher may rename in place: the deletion grade, with one exception.
 *
 * The boundary: the Mods folder of a configured installation may itself be a symbolic link, or sit
 * behind one, because that is the folder the scan already supports (#237) and offering a toggle that
 * always refuses on a setup the launcher lists happily is the bug; the archive is then checked where
 * that folder really lives and has to be a regular file, so an archive that is itself a link, or one
 * a level deeper behind a link planted inside the folder, is refused exactly as a delete refuses it.
 */
export async function assertManagedModArchivePath(value: unknown): Promise<string> {
  const config = await getConfig()
  const namedPath = await assertManagedDeletionPath(value, { allowSymlinks: true })
  const folder = dirname(namedPath)

  if (!config.installations.some((installation) => comparablePath(join(installation.path, MODS_FOLDER_NAME)) === comparablePath(folder))) return assertManagedDeletionPath(value)

  const archive = await fse.lstat(join(await fse.realpath(folder), basename(namedPath)))
  if (archive.isSymbolicLink() || !archive.isFile()) throw new TypeError("Symbolic links are not allowed for managed paths")
  return namedPath
}

/**
 * The folder of an Installation the config names, and nothing else: not a folder under the
 * installations root, not a subfolder of an Installation. `assertManagedPath` alone would grant the
 * whole managed tree, which is wider than a channel acting on one Installation's own files needs.
 */
export async function assertConfiguredInstallationPath(value: unknown): Promise<string> {
  const pathValue = resolve(assertNonRootPath(value, "installation path"))
  const config = await getConfig()
  if (!config.installations.some((installation) => comparablePath(installation.path) === comparablePath(pathValue))) throw new TypeError("Unconfigured installation path")
  return pathValue
}

/**
 * The paths in `nextConfig` that nothing authorizes: neither a folder or entry the current config
 * already names, nor a place the user just picked in a native dialog. Empty means the save may go on.
 *
 * Named rather than counted so SAVE_CONFIG can tell the renderer which entries to drop. One refused
 * path left in the renderer's state is refused again by every later save, which carries the whole state.
 */
export function unauthorizedConfigPaths(nextConfig: ConfigType, currentConfig: ConfigType): string[] {
  const existingGrants = getConfigDeclarationGrants(currentConfig)
  const candidatePaths = [
    nextConfig.defaultInstallationsFolder,
    nextConfig.defaultVersionsFolder,
    nextConfig.backupsFolder,
    ...nextConfig.installations.map((installation) => installation.path),
    ...nextConfig.installations.flatMap((installation) => installation.backups.map((backup) => backup.path)),
    ...nextConfig.installations.flatMap((installation) => (installation.worldBackups ?? []).map((backup) => backup.path)),
    ...nextConfig.gameVersions.map((gameVersion) => gameVersion.path)
  ]

  return candidatePaths.filter((candidatePath) => !candidatePath || !(isPathGranted(existingGrants, candidatePath) || isUserApprovedPath(candidatePath)))
}
