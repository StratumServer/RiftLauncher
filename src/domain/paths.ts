/**
 * The filesystem family a folder comparison reads paths as: Windows (case-insensitive, both
 * separators), macOS (case-insensitive by default, / only) or the rest (case-sensitive, / only).
 */
export type FolderPlatform = "win32" | "darwin" | "posix"

/** Maps the host's `process.platform` spelling onto the family folder comparison cares about. */
export function toFolderPlatform(os: string): FolderPlatform {
  return os === "win32" || os === "darwin" ? os : "posix"
}

/**
 * Normalizes a folder path for equality comparison.
 *
 * Strips trailing path separators (/ and \). On win32, unifies backslashes to
 * forward slashes and lowercases. On darwin, lowercases: a default macOS volume
 * folds case, so "Creative-World" and "creative-world" are one folder there. On
 * posix, backslash is a legal filename character and is left untouched.
 *
 * This does NOT resolve symlinks or relative segments: that is the host's job
 * before handing paths into the domain.
 */
export function normalizeFolderForComparison(folder: string, platform: FolderPlatform = detectPlatform(folder)): string {
  let normalized = folder
  while (normalized.endsWith("/") || normalized.endsWith("\\")) normalized = normalized.slice(0, -1)
  if (platform === "win32") normalized = normalized.replaceAll("\\", "/").toLowerCase()
  if (platform === "darwin") normalized = normalized.toLowerCase()
  return normalized
}

/** Detects platform from path shape when not explicitly provided. */
function detectPlatform(path: string): FolderPlatform {
  return /^(?:[a-zA-Z]:|\\\\|\/\/)/.test(path) ? "win32" : "posix"
}

/**
 * The folder a file sits in: its path up to the last separator.
 *
 * Text only, like normalizeFolderForComparison: nothing is resolved and the case and the separators
 * come back as given, so the result can go straight back to the host. Windows reads / and \ alike,
 * Linux only /. Undefined when there is no folder to name, a path with no separator or one directly
 * under a root, so a caller never asks the host about an empty path.
 */
export function parentFolder(filePath: string): string | undefined {
  const cut = detectPlatform(filePath) === "win32" ? Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) : filePath.lastIndexOf("/")
  return cut > 0 ? filePath.slice(0, cut) : undefined
}

/** Checks whether a folder is already spoken for, with path normalization. */
export function folderIsInUse(folder: string, foldersInUse: readonly string[], platform?: FolderPlatform): boolean {
  const target = normalizeFolderForComparison(folder, platform)
  return foldersInUse.some((used) => normalizeFolderForComparison(used, platform) === target)
}

/**
 * True when `folder` sits anywhere below `outer`. A folder is not below itself, and an empty
 * `outer` (a setting the config has not filled in yet) holds nothing, where the root "/" holds all.
 */
export function folderIsInside(folder: string, outer: string, platform?: FolderPlatform): boolean {
  return outer !== "" && normalizeFolderForComparison(folder, platform).startsWith(`${normalizeFolderForComparison(outer, platform)}/`)
}

/**
 * Checks whether a folder is spoken for, or shares data with one that is: the same folder, one
 * inside it, or one that holds it. Wiping a folder takes everything below it, so two such folders
 * cannot both be managed.
 */
export function folderOverlapsInUse(folder: string, foldersInUse: readonly string[], platform?: FolderPlatform): boolean {
  return foldersInUse.some((used) => folderIsInUse(folder, [used], platform) || folderIsInside(folder, used, platform) || folderIsInside(used, folder, platform))
}

/**
 * The first of `managedFolders` that `folder` is, or holds: the one a wipe of `folder` would take
 * with it. Folders inside `folder` count, folders around it do not. Null when it holds none.
 */
export function firstHeldFolder(folder: string, managedFolders: readonly string[], platform?: FolderPlatform): string | null {
  return managedFolders.find((managed) => folderIsInUse(folder, [managed], platform) || folderIsInside(managed, folder, platform)) ?? null
}

/**
 * The first folder nothing registered occupies: `base` itself, then `base-2`, `base-3` and so on.
 *
 * Used to suggest where a new install goes, so a second build of a version the launcher already
 * holds is not offered the folder of the first. It always finds one: each taken candidate is a
 * distinct entry of `foldersInUse`, so the search ends within `foldersInUse.length` steps and never
 * hands back a folder the install would refuse.
 */
export function firstFreeFolder(base: string, foldersInUse: readonly string[], platform?: FolderPlatform): string {
  let candidate = base
  for (let n = 2; folderIsInUse(candidate, foldersInUse, platform); n++) candidate = `${base}-${n}`
  return candidate
}
