import { app } from "electron"
import fse from "fs-extra"
import { basename, dirname, resolve } from "node:path"

import { getConfig } from "@src/config/configManager"
import type { PathGrant } from "@src/ipc/validation"
import { assertNonRootPath, comparablePath, isPathGranted, isRestoreWorkspaceName } from "@src/ipc/validation"

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
  return [resolve(app.getPath("userData"), "Logs"), resolve(app.getPath("userData"), "Cache"), resolve(app.getPath("userData"), "Icons")]
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

function getProtectedPaths(config: ConfigType): string[] {
  return [app.getPath("userData"), app.getPath("appData"), app.getPath("home"), app.getAppPath(), ...getConfiguredFolders(config), ...getLauncherFolders()]
}

function assertNoSymlinkComponents(pathValue: string): void {
  let current = resolve(pathValue)
  let parent = dirname(current)

  while (!fse.existsSync(current)) {
    if (parent === current) break
    current = parent
    parent = dirname(current)
  }

  while (current !== parent) {
    const stats = fse.lstatSync(current)
    if (stats.isSymbolicLink()) throw new TypeError("Symbolic links are not allowed for managed paths")
    current = parent
    parent = dirname(current)
  }

  const rootStats = fse.lstatSync(current)
  if (rootStats.isSymbolicLink()) throw new TypeError("Symbolic links are not allowed for managed paths")
}

export async function assertManagedPath(value: unknown, name = "path", options: PathPolicyOptions = {}): Promise<string> {
  const pathValue = resolve(assertNonRootPath(value, name))
  const config = await getConfig()
  const isConfiguredPath = isPathGranted(getManagedPathGrants(config), pathValue)
  const isApprovedPath = options.allowApprovedSelection !== false && isUserApprovedPath(pathValue)
  const isRestoreWorkspace = config.installations.some((installation) => isRestoreWorkspaceOf(installation.path, pathValue))
  if (!isConfiguredPath && !isApprovedPath && !isRestoreWorkspace) throw new TypeError(`Unmanaged ${name}`)

  if (!options.allowMissing && !fse.existsSync(pathValue)) throw new TypeError(`Missing ${name}`)
  if (!options.allowSymlinks) assertNoSymlinkComponents(pathValue)
  return pathValue
}

export async function assertManagedDeletionPath(value: unknown): Promise<string> {
  const config = await getConfig()
  const pathValue = await assertManagedPath(value, "deletion path", { allowMissing: false })
  if (getProtectedPaths(config).some((protectedPath) => comparablePath(protectedPath) === comparablePath(pathValue))) throw new TypeError("Protected path")
  return pathValue
}

export async function assertConfigPathsAuthorized(nextConfig: ConfigType, currentConfig: ConfigType): Promise<boolean> {
  const existingGrants = getConfigDeclarationGrants(currentConfig)
  const candidatePaths = [
    nextConfig.defaultInstallationsFolder,
    nextConfig.defaultVersionsFolder,
    nextConfig.backupsFolder,
    ...nextConfig.installations.map((installation) => installation.path),
    ...nextConfig.installations.flatMap((installation) => installation.backups.map((backup) => backup.path)),
    ...nextConfig.gameVersions.map((gameVersion) => gameVersion.path)
  ]

  return candidatePaths.every((candidatePath) => {
    if (!candidatePath) return false
    return isPathGranted(existingGrants, candidatePath) || isUserApprovedPath(candidatePath)
  })
}
