import type { GameBuildVariant } from "./versions/detect"

/** The longest name assertSafeFileName (src/ipc/validation.ts) lets through. */
const MAX_FOLDER_NAME_LENGTH = 255

/** The longest label normalizeGameVersion (src/config/configManager.ts) keeps; past it the label is dropped entirely. */
export const MAX_GAME_VERSION_LABEL_LENGTH = 256

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
 * Formats an epoch-millisecond timestamp as a filesystem-safe stamp:
 * `YYYY-MM-DD_HH-mm-ss`, in the host's own time zone.
 *
 * The fixed field order and the separators are what make this safe on every
 * filesystem, unlike a `toLocaleString` call, which used to hand out grouping
 * dots for some locales and colons for others. That part has not changed.
 *
 * The time zone has. This stamp only ever names a backup archive, and the
 * backups list next to it renders the same instant with `toLocaleString`, so a
 * UTC stamp put the two two hours apart on screen for one file (#411). Nothing
 * reads the stamp back: pruning walks the records newest first and restoring
 * opens the path recorded with the backup, both off the epoch millis kept in
 * the config, so no ordering in the launcher depends on how the name sorts.
 * The one thing local time costs is a file manager sorting a folder by name
 * across the hour a daylight-saving change repeats, which the launcher itself
 * never does.
 *
 * @param epochMillis Milliseconds since the Unix epoch, typically ports.clock.now().
 * @returns A stamp like "2026-08-16_09-41-07", read the way a clock on the wall would.
 */
export function formatTimestampForFilename(epochMillis: number): string {
  const date = new Date(epochMillis)
  const pad = (value: number): string => value.toString().padStart(2, "0")

  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  const seconds = pad(date.getSeconds())

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`
}

/**
 * Spells out how a registered build is named in the VS Versions list.
 *
 * One place rather than one per caller: the "add an already installed VS
 * Version" page seeds its Name field with this, and anything that ever labels a
 * build for the player should read the same way. A build with no variant is
 * named by its version number alone, which is what every row said before forks
 * were detected at all.
 *
 * The label is a display string and nothing else. Nothing compares versions
 * through it, and nothing logs it: the player can overwrite it with anything.
 *
 * The result is cut to what the config keeps. normalizeGameVersion drops a
 * longer label for the bare version number rather than truncating it, so a
 * label past the cap is not a long name, it is no name at all: the row would
 * show what was typed until the next load and the version number after it. A
 * variant version is only bounded by what semver accepts, which is 256
 * characters of pre-release tail, so a build naming itself at that length can
 * reach the cap on its own.
 *
 * @param version The game version number, as detection read it.
 * @param variant The fork that named itself, when one did.
 * @returns "1.22.7", or "1.22.7 Optimum 0.3.14".
 */
export function buildGameVersionLabel(version: string, variant?: GameBuildVariant): string {
  return (variant ? `${version} ${variant.name} ${variant.version}` : version).slice(0, MAX_GAME_VERSION_LABEL_LENGTH)
}
