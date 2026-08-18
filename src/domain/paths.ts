/**
 * Normalizes a folder path for equality comparison.
 *
 * Strips trailing path separators (/ and \) so that "/opt/game" and
 * "/opt/game/" compare as equal. On Windows (detected by a drive letter or
 * backslash presence), also lowercases to handle the case-insensitive
 * filesystem.
 *
 * This does NOT resolve symlinks or relative segments: that is the host's job
 * before handing paths into the domain.
 */
export function normalizeFolderForComparison(folder: string): string {
  let normalized = folder.replace(/[\\/]+$/, "")
  if (looksLikeWindows(normalized)) normalized = normalized.toLowerCase()
  return normalized
}

/** A cheap heuristic: a drive letter or any backslash means Windows paths. */
function looksLikeWindows(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.includes("\\")
}

/** Checks whether a folder is already spoken for, with path normalization. */
export function folderIsInUse(folder: string, foldersInUse: readonly string[]): boolean {
  const target = normalizeFolderForComparison(folder)
  return foldersInUse.some((used) => normalizeFolderForComparison(used) === target)
}
