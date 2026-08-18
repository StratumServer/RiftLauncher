/**
 * Normalizes a folder path for equality comparison.
 *
 * Strips trailing path separators (/ and \), unifies separators to forward
 * slashes, and on the given platform lowercases to handle case-insensitive
 * filesystems (win32).
 *
 * This does NOT resolve symlinks or relative segments: that is the host's job
 * before handing paths into the domain.
 */
export function normalizeFolderForComparison(folder: string, platform: "win32" | "posix" = detectPlatform(folder)): string {
  let normalized = folder.replace(/[\\/]+$/, "").replace(/\\/g, "/")
  if (platform === "win32") normalized = normalized.toLowerCase()
  return normalized
}

/** Detects platform from path shape when not explicitly provided. */
function detectPlatform(path: string): "win32" | "posix" {
  return /^[a-zA-Z]:/.test(path) ? "win32" : "posix"
}

/** Checks whether a folder is already spoken for, with path normalization. */
export function folderIsInUse(folder: string, foldersInUse: readonly string[], platform?: "win32" | "posix"): boolean {
  const target = normalizeFolderForComparison(folder, platform)
  return foldersInUse.some((used) => normalizeFolderForComparison(used, platform) === target)
}
