/**
 * Normalizes a folder path for equality comparison.
 *
 * Strips trailing path separators (/ and \). On win32, unifies backslashes to
 * forward slashes and lowercases. On posix, backslash is a legal filename
 * character and is left untouched.
 *
 * This does NOT resolve symlinks or relative segments: that is the host's job
 * before handing paths into the domain.
 */
export function normalizeFolderForComparison(folder: string, platform: "win32" | "posix" = detectPlatform(folder)): string {
  let normalized = folder
  while (normalized.endsWith("/") || normalized.endsWith("\\")) normalized = normalized.slice(0, -1)
  if (platform === "win32") normalized = normalized.replaceAll("\\", "/").toLowerCase()
  return normalized
}

/** Detects platform from path shape when not explicitly provided. */
function detectPlatform(path: string): "win32" | "posix" {
  return /^(?:[a-zA-Z]:|\\\\|\/\/)/.test(path) ? "win32" : "posix"
}

/** Checks whether a folder is already spoken for, with path normalization. */
export function folderIsInUse(folder: string, foldersInUse: readonly string[], platform?: "win32" | "posix"): boolean {
  const target = normalizeFolderForComparison(folder, platform)
  return foldersInUse.some((used) => normalizeFolderForComparison(used, platform) === target)
}

/**
 * The first folder nothing registered occupies: `base` itself, then `base-2`, `base-3` and so on.
 *
 * Used to suggest where a new install goes, so a second build of a version the launcher already
 * holds is not offered the folder of the first. It always finds one: each taken candidate is a
 * distinct entry of `foldersInUse`, so the search ends within `foldersInUse.length` steps and never
 * hands back a folder the install would refuse.
 */
export function firstFreeFolder(base: string, foldersInUse: readonly string[], platform?: "win32" | "posix"): string {
  let candidate = base
  for (let n = 2; folderIsInUse(candidate, foldersInUse, platform); n++) candidate = `${base}-${n}`
  return candidate
}
