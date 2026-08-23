import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { RESTORE_REPLACED_SUFFIX, RESTORE_STAGING_SUFFIX } from "../domain/installations/restore"

export const MAX_IPC_STRING_LENGTH = 8_192
export const MAX_PATH_LENGTH = 4_096
export const MAX_URL_LENGTH = 2_048
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
export const MAX_LOGIN_RESPONSE_BYTES = 512 * 1024
export const MAX_ARCHIVE_ENTRY_BYTES = 512 * 1024 * 1024
export const MAX_ARCHIVE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
// The mods catalog has no server-side pagination: one growth spurt of the ~8000-mod
// list (about 3.5 MB today) can outgrow the generic 4 MB ceiling with no fallback.
// 16 MB gives years of headroom while staying a bounded, allow-listed exception rather
// than an unbounded response.
export const MAX_MODS_CATALOG_RESPONSE_BYTES = 16 * 1024 * 1024
// The background manifest is a list of {id, name, file} rows, about 1 KB for the eleven scenes
// on the branch today. 32 KB is room for hundreds of them and still refuses anything that is
// not a small list of names.
export const MAX_BACKGROUND_MANIFEST_BYTES = 32 * 1024
// One background scene. The branch's own files run 400 to 720 KB at 2560x1440, so 2 MB is
// roughly triple the largest of them, and well under the generic 4 MB ceiling this would
// otherwise inherit.
export const MAX_BACKGROUND_IMAGE_BYTES = 2 * 1024 * 1024

export type UrlRule = Readonly<{
  hostname: string
  pathPrefixes: readonly string[]
  // Optional per-rule response ceiling. Falls back to MAX_RESPONSE_BYTES when unset.
  maxBytes?: number
}>

export const API_URL_RULES: readonly UrlRule[] = [
  { hostname: "api.vintagestory.at", pathPrefixes: ["/stable.json", "/unstable.json"] },
  { hostname: "mods.vintagestory.at", pathPrefixes: ["/api/mods"], maxBytes: MAX_MODS_CATALOG_RESPONSE_BYTES },
  { hostname: "mods.vintagestory.at", pathPrefixes: ["/api"] },
  { hostname: "auth3.vintagestory.at", pathPrefixes: ["/v2/gamelogin"] },
  // The launcher's own background catalog, on this repository's `backgrounds` branch and nothing
  // else raw.githubusercontent.com serves. The manifest rule sits first so its much smaller
  // ceiling wins the match; findMatchingRule takes the first rule that covers the path.
  { hostname: "raw.githubusercontent.com", pathPrefixes: ["/StratumServer/RiftLauncher/backgrounds/manifest.json"], maxBytes: MAX_BACKGROUND_MANIFEST_BYTES },
  { hostname: "raw.githubusercontent.com", pathPrefixes: ["/StratumServer/RiftLauncher/backgrounds"], maxBytes: MAX_BACKGROUND_IMAGE_BYTES }
]

export const DOWNLOAD_URL_RULES: readonly UrlRule[] = [
  { hostname: "cdn.vintagestory.at", pathPrefixes: ["/"] },
  { hostname: "mods.vintagestory.at", pathPrefixes: ["/download"] },
  { hostname: "moddbcdn.vintagestory.at", pathPrefixes: ["/"] }
]

export const BROWSER_URL_RULES: readonly UrlRule[] = [
  { hostname: "discord.gg", pathPrefixes: ["/vQm6z2urZs"] },
  { hostname: "github.com", pathPrefixes: ["/StratumServer/RiftLauncher"] },
  { hostname: "mods.vintagestory.at", pathPrefixes: ["/show"] },
  { hostname: "wiki.vintagestory.at", pathPrefixes: ["/"] },
  { hostname: "www.youtube.com", pathPrefixes: ["/watch"] }
]

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function assertString(value: unknown, name: string, maxLength = MAX_IPC_STRING_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new TypeError(`Invalid ${name}`)
  }

  return value
}

export function assertOptionalString(value: unknown, name: string, maxLength = MAX_IPC_STRING_LENGTH): string | undefined {
  if (value === undefined) return undefined
  return assertString(value, name, maxLength)
}

function assertBoundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) throw new TypeError(`Invalid ${name}`)
  return value
}

export function assertPath(value: unknown, name = "path"): string {
  return assertString(value, name, MAX_PATH_LENGTH)
}

export function assertNonRootPath(value: unknown, name = "path"): string {
  const pathValue = assertPath(value, name)
  const resolvedPath = resolve(pathValue)

  if (resolvedPath === resolve(resolvedPath, "..")) throw new TypeError(`Invalid ${name}`)

  return pathValue
}

/**
 * Puts a path in the shape two paths have to be in before they can be compared:
 * absolute, and lower cased on Windows, whose file systems do not distinguish
 * case.
 */
export function comparablePath(value: string): string {
  const resolved = resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** True when `candidate` sits under `root`, or is `root` itself when `allowRoot`. */
export function isPathWithin(root: string, candidate: string, allowRoot = true): boolean {
  const relativePath = relative(comparablePath(root), comparablePath(candidate))
  return (allowRoot && relativePath === "") || (relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

/**
 * One entry of a path allow list.
 *
 * `descendants` is the whole difference between a folder the launcher owns and
 * a single file it happens to know about. A folder grant reaches everything
 * under it, because that is where mods, saves and game files live. A file grant
 * reaches that one path and nothing else: an archive has no inside as far as
 * the file system is concerned, so treating it as a folder only ever widens
 * what the launcher accepts.
 *
 * Either way the granted path itself is covered. A grant that did not cover its
 * own path would authorize nothing a caller ever asks about.
 */
export type PathGrant = {
  path: string
  descendants: boolean
}

/** True when at least one grant covers `candidate`. */
export function isPathGranted(grants: readonly PathGrant[], candidate: string): boolean {
  return grants.some((grant) => (grant.descendants ? isPathWithin(grant.path, candidate) : comparablePath(grant.path) === comparablePath(candidate)))
}

export function assertSafeTaskId(value: unknown): string {
  const id = assertString(value, "task id", 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new TypeError("Invalid task id")
  return id
}

export function assertSafeFileName(value: unknown, name = "file name"): string {
  const fileName = assertString(value, name, 255)
  if (fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\")) throw new TypeError(`Invalid ${name}`)
  return fileName
}

export function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`Invalid ${name}`)
  return value
}

export function assertFiniteNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`Invalid ${name}`)
  return value
}

export function assertInteger(value: unknown, name: string, min: number, max: number): number {
  const numberValue = assertFiniteNumber(value, name, min, max)
  if (!Number.isInteger(numberValue)) throw new TypeError(`Invalid ${name}`)
  return numberValue
}

export function validateGameVersion(value: unknown): GameVersionType {
  if (!isRecord(value)) throw new TypeError("Invalid game version")
  return {
    version: assertString(value.version, "game version", 128),
    path: assertNonRootPath(value.path, "game version path")
  }
}

export function validateGameInstallation(value: unknown): Pick<InstallationType, "path" | "startParams" | "mesaGlThread" | "envVars"> {
  if (!isRecord(value)) throw new TypeError("Invalid installation")
  return {
    path: assertNonRootPath(value.path, "installation path"),
    startParams: assertBoundedString(value.startParams, "start parameters", 8_192),
    mesaGlThread: assertBoolean(value.mesaGlThread, "MESA GL thread flag"),
    envVars: assertBoundedString(value.envVars, "environment variables", 8_192)
  }
}

const DENIED_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_DEBUG",
  "LD_ASSUME_KERNEL",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "GCONV_PATH",
  "BASH_ENV",
  "ENV",
  "PERL5OPT",
  "PERL5LIB",
  "PYTHONPATH",
  "PYTHONINSPECT",
  "RUBYOPT",
  "RUBYLIB",
  "NODE_OPTIONS",
  "NODE_PATH",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
  "DOTNET_STARTUP_HOOKS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_SSH_COMMAND"
])

const DENIED_ENVIRONMENT_PREFIXES = ["COMPLUS_", "DYLD_", "LD_"]

export function parseSafeEnvironment(value: string): Record<string, string> {
  if (!value) return {}
  const entries = value.split(",")
  if (entries.length > 128) throw new TypeError("Too many environment variables")

  const environment: Record<string, string> = {}
  for (const entry of entries) {
    const separator = entry.indexOf("=")
    if (separator <= 0) throw new TypeError("Invalid environment variable")
    const key = entry.slice(0, separator).trim()
    const environmentValue = entry.slice(separator + 1)
    const normalizedKey = key.toUpperCase()
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      DENIED_ENVIRONMENT_KEYS.has(normalizedKey) ||
      DENIED_ENVIRONMENT_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix)) ||
      environmentValue.length > 2_048 ||
      environmentValue.includes("\0")
    ) {
      throw new TypeError("Invalid environment variable")
    }
    environment[key] = environmentValue
  }

  return environment
}

function pathMatches(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname.startsWith("/")
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function findMatchingRule(rules: readonly UrlRule[], hostname: string, pathname: string): UrlRule | undefined {
  return rules.find((candidate) => candidate.hostname === hostname && candidate.pathPrefixes.some((prefix) => pathMatches(pathname, prefix)))
}

function parseAllowedUrl(value: unknown, rules: readonly UrlRule[]): URL {
  const rawUrl = assertString(value, "url", MAX_URL_LENGTH)
  let parsedUrl: URL

  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    throw new TypeError("Invalid URL")
  }

  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.port) throw new TypeError("Invalid URL")

  if (!findMatchingRule(rules, parsedUrl.hostname.toLowerCase(), parsedUrl.pathname)) throw new TypeError("URL is not allowed")

  return parsedUrl
}

export function assertAllowedApiUrl(value: unknown): URL {
  return parseAllowedUrl(value, API_URL_RULES)
}

/**
 * Resolves the response-size ceiling for an already-validated API URL, honoring a
 * per-rule override (see API_URL_RULES) and falling back to the generic MAX_RESPONSE_BYTES.
 */
export function getApiUrlMaxBytes(url: URL): number {
  const rule = findMatchingRule(API_URL_RULES, url.hostname.toLowerCase(), url.pathname)
  return rule?.maxBytes ?? MAX_RESPONSE_BYTES
}

export function assertAllowedDownloadUrl(value: unknown): URL {
  return parseAllowedUrl(value, DOWNLOAD_URL_RULES)
}

export function assertAllowedBrowserUrl(value: unknown): URL {
  return parseAllowedUrl(value, BROWSER_URL_RULES)
}

export function isAllowedRendererUrl(value: unknown, developmentUrl: string | undefined, packagedRendererPath: string): boolean {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return false

  try {
    const parsedUrl = new URL(value)
    if (developmentUrl !== undefined) {
      const expectedDevelopmentUrl = new URL(developmentUrl)
      if (parsedUrl.protocol === expectedDevelopmentUrl.protocol && parsedUrl.host === expectedDevelopmentUrl.host && parsedUrl.pathname === expectedDevelopmentUrl.pathname) return true
    }

    if (
      parsedUrl.protocol === "app:" &&
      parsedUrl.hostname === "renderer" &&
      !parsedUrl.username &&
      !parsedUrl.password &&
      !parsedUrl.port &&
      parsedUrl.pathname === "/index.html" &&
      !parsedUrl.search
    ) {
      return true
    }

    if (parsedUrl.protocol !== "file:" || parsedUrl.username || parsedUrl.password || parsedUrl.search) return false
    return resolve(fileURLToPath(parsedUrl)) === resolve(packagedRendererPath)
  } catch {
    return false
  }
}

export function resolveContainedPath(root: string, relativePath: string): string | null {
  let decodedPath: string

  try {
    decodedPath = decodeURIComponent(relativePath)
  } catch {
    return null
  }

  if (decodedPath.includes("\0")) return null

  const safeRelativePath = decodedPath.replace(/^[/\\]+/, "")
  if (!safeRelativePath || safeRelativePath.split(/[\\/]+/).includes("..")) return null

  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(resolvedRoot, safeRelativePath)
  const relativePathFromRoot = relative(resolvedRoot, resolvedPath)

  if (!relativePathFromRoot || relativePathFromRoot.startsWith("..") || isAbsolute(relativePathFromRoot)) return null

  return resolvedPath
}

export function isSafeArchiveEntry(entryName: unknown): entryName is string {
  if (typeof entryName !== "string" || entryName.length === 0 || entryName.length > MAX_PATH_LENGTH || entryName.includes("\0")) return false

  const normalizedName = entryName.replaceAll("\\", "/")
  if (normalizedName.startsWith("/") || /^[A-Za-z]:\//.test(normalizedName)) return false

  return !normalizedName.split("/").includes("..")
}

const RESTORE_WORKSPACE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * True when `candidateName` is one of the two temporary folders the backup
 * restore puts beside an installation folder named `installationName`.
 *
 * Folder names only, no path parts. The caller is the one that checks both
 * names live in the same parent folder.
 */
export function isRestoreWorkspaceName(installationName: string, candidateName: string): boolean {
  if (!installationName || !candidateName.startsWith(installationName)) return false

  const remainder = candidateName.slice(installationName.length)
  return [RESTORE_STAGING_SUFFIX, RESTORE_REPLACED_SUFFIX].some((suffix) => remainder.startsWith(suffix) && RESTORE_WORKSPACE_TOKEN_PATTERN.test(remainder.slice(suffix.length)))
}

/**
 * True when `name` is a gzipped tar, which 7-Zip cannot unpack in one pass and,
 * for the archives Vintage Story ships, cannot read at all.
 */
export function isTarGzName(name: unknown): boolean {
  return typeof name === "string" && /\.(?:tar\.gz|tgz)$/i.test(name)
}

/**
 * Tar entry kinds that become a plain file or folder on disk.
 *
 * Everything else, symbolic links and hard links included, is refused: the
 * extraction only ever writes files and directories, so an archive asking for
 * anything else is not one the launcher unpacks.
 */
const SAFE_TAR_ENTRY_TYPES: ReadonlySet<string> = new Set(["File", "OldFile", "ContiguousFile", "Directory"])

export function isSafeTarEntryType(entryType: unknown): boolean {
  return typeof entryType === "string" && SAFE_TAR_ENTRY_TYPES.has(entryType)
}

export function isArchiveSymlink(externalFileAttributes: unknown): boolean {
  if (typeof externalFileAttributes !== "number" || !Number.isFinite(externalFileAttributes)) return false

  const unixMode = (externalFileAttributes >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}
