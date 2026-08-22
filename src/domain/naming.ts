/** The longest name assertSafeFileName (src/ipc/validation.ts) lets through. */
const MAX_FOLDER_NAME_LENGTH = 255

/**
 * Strips characters a folder name cannot carry and collapses the leftovers into
 * single dashes.
 *
 * What comes out is what the path layer already accepts: no path separator and
 * no other character Windows refuses, no run of whitespace, no leading or
 * trailing dash, and nothing longer than assertSafeFileName's 255 characters.
 * The two names that layer refuses outright, "." and "..", come back empty
 * along with anything else made only of dots, since a segment of pure
 * punctuation is a worse folder name than no segment at all. Callers decide
 * what an empty result means for them: appending nothing, or falling back to
 * something of their own.
 *
 * @param folderName Raw name, typically typed by the user.
 * @returns The sanitised name, possibly empty.
 */
export function cleanFolderName(folderName: string): string {
  const cleaned = folderName
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_FOLDER_NAME_LENGTH)
    // The slice can land mid-name and leave the dash the trim above just removed.
    .replace(/-$/, "")

  return /^\.+$/.test(cleaned) ? "" : cleaned
}

/**
 * Formats an epoch-millisecond timestamp as a deterministic, filesystem-safe
 * stamp: `YYYY-MM-DD_HH-mm-ss`, always in UTC.
 *
 * UTC keeps the stamp reproducible regardless of the host's locale or time
 * zone (unlike a `toLocaleString` call, which used to hand out grouping dots
 * for some locales and colons for others). The field order also keeps stamps
 * sortable byte-for-byte the same way they sort chronologically, which a
 * plain locale string does not.
 *
 * @param epochMillis Milliseconds since the Unix epoch, typically ports.clock.now().
 * @returns A stamp like "2026-08-16_09-41-07".
 */
export function formatTimestampForFilename(epochMillis: number): string {
  const date = new Date(epochMillis)
  const pad = (value: number): string => value.toString().padStart(2, "0")

  const year = date.getUTCFullYear()
  const month = pad(date.getUTCMonth() + 1)
  const day = pad(date.getUTCDate())
  const hours = pad(date.getUTCHours())
  const minutes = pad(date.getUTCMinutes())
  const seconds = pad(date.getUTCSeconds())

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`
}
