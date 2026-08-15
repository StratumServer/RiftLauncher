import { app } from "electron"
import fse from "fs-extra"
import { dirname, isAbsolute, relative, resolve, sep } from "path"

import { getConfig } from "@src/config/configManager"
import { assertNonRootPath } from "@src/ipc/validation"

type ApprovedPath = {
  path: string
  descendants: boolean
  expiresAt: number
}

type PathPolicyOptions = {
  allowMissing?: boolean
  allowApprovedSelection?: boolean
}

const approvedPaths: ApprovedPath[] = []
const APPROVAL_TTL_MS = 10 * 60 * 1_000

function comparablePath(value: string): string {
  const resolved = resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function isPathWithin(root: string, candidate: string, allowRoot = true): boolean {
  const relativePath = relative(comparablePath(root), comparablePath(candidate))
  return (allowRoot && relativePath === "") || (relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function pruneApprovals(): void {
  const now = Date.now()
  for (let index = approvedPaths.length - 1; index >= 0; index--) {
    if (approvedPaths[index].expiresAt <= now) approvedPaths.splice(index, 1)
  }
}

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
  return approvedPaths.some((approved) => isPathWithin(approved.path, pathValue, approved.descendants))
}

function getConfiguredRoots(config: ConfigType): string[] {
  return [
    config.defaultInstallationsFolder,
    config.defaultVersionsFolder,
    config.backupsFolder,
    ...config.installations.map((installation) => installation.path),
    ...config.installations.flatMap((installation) => installation.backups.map((backup) => backup.path)),
    ...config.gameVersions.map((gameVersion) => gameVersion.path),
    resolve(app.getPath("userData"), "Logs"),
    resolve(app.getPath("userData"), "Cache"),
    resolve(app.getPath("userData"), "Icons")
  ].filter((pathValue): pathValue is string => typeof pathValue === "string" && pathValue.length > 0)
}

function getProtectedPaths(config: ConfigType): string[] {
  return [
    app.getPath("userData"),
    app.getPath("appData"),
    app.getPath("home"),
    app.getAppPath(),
    config.defaultInstallationsFolder,
    config.defaultVersionsFolder,
    config.backupsFolder,
    resolve(app.getPath("userData"), "Logs"),
    resolve(app.getPath("userData"), "Cache"),
    resolve(app.getPath("userData"), "Icons")
  ]
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
  const roots = getConfiguredRoots(config)
  const isConfiguredPath = roots.some((root) => isPathWithin(root, pathValue))
  const isApprovedPath = options.allowApprovedSelection !== false && isUserApprovedPath(pathValue)
  if (!isConfiguredPath && !isApprovedPath) throw new TypeError(`Unmanaged ${name}`)

  if (!options.allowMissing && !fse.existsSync(pathValue)) throw new TypeError(`Missing ${name}`)
  assertNoSymlinkComponents(pathValue)
  return pathValue
}

export async function assertManagedDeletionPath(value: unknown): Promise<string> {
  const config = await getConfig()
  const pathValue = await assertManagedPath(value, "deletion path", { allowMissing: false })
  if (getProtectedPaths(config).some((protectedPath) => comparablePath(protectedPath) === comparablePath(pathValue))) throw new TypeError("Protected path")
  return pathValue
}

export async function assertConfigPathsAuthorized(nextConfig: ConfigType, currentConfig: ConfigType): Promise<boolean> {
  const existingRoots = getConfiguredRoots(currentConfig)
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
    return existingRoots.some((existingRoot) => isPathWithin(existingRoot, candidatePath)) || isUserApprovedPath(candidatePath)
  })
}
