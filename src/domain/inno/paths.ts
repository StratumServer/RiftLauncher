/**
 * Turning a destination the installer declares into a path that may be written.
 *
 * The installer is a file fetched from the network. It does not get to decide
 * where the launcher writes, which is the same rule the archive extraction
 * already applies to tar entries. Anything that could climb out of the version
 * folder, name a drive, or start from the root is refused rather than trimmed
 * into something acceptable: a path that has to be repaired is a path nobody
 * meant to write.
 */

/** Prefix of the destinations that make up the game itself. */
export const APP_PREFIX = "{app}\\"

/**
 * The part of a destination that lives under the version folder.
 *
 * @param destination Destination as the script writes it.
 * @returns The stored path under the version folder, or undefined when the entry
 * is not destined for it at all.
 */
export function relativeAppPath(destination: string): string | undefined {
  if (destination.length <= APP_PREFIX.length) return undefined
  if (destination.slice(0, APP_PREFIX.length).toLowerCase() !== APP_PREFIX.toLowerCase()) return undefined
  return destination.slice(APP_PREFIX.length)
}

/**
 * Checks a stored path and returns it in the one shape a sink is handed.
 *
 * @param storedPath Path as the installer stores it, backslashes and all.
 * @returns Forward slash path, or undefined when it must not be written.
 */
export function safeRelativePath(storedPath: string): string | undefined {
  const normalized = storedPath.replaceAll("\\", "/")
  // Refused rather than quietly turned relative: an entry naming the root meant
  // to write to the root.
  if (normalized.startsWith("/")) return undefined

  const kept: string[] = []

  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") return undefined
    // A drive letter or a stream name has no business in a relative path, and on
    // Windows `c:file` resolves against that drive's own current directory.
    if (segment.includes(":")) return undefined
    if (hasControlCharacter(segment)) return undefined
    kept.push(segment)
  }

  if (kept.length === 0) return undefined
  return kept.join("/")
}

/** A NUL or another control byte in a name means the read went somewhere it should not have. */
function hasControlCharacter(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    const code = segment.codePointAt(i) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
