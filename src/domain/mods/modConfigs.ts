/**
 * The longest whole key a pack may use. Each of its segments is held to safe filename limit of 255.
 */
export const MAX_MOD_CONFIG_KEY_LENGTH = 512

/**
 * Names Windows refuses to create a file under, with or without an extension: the DOS device names
 * that predate NTFS and still work, and the numbered variants of the two port families. `¹` is not a
 * digit to Windows either, which is why it is spelled out rather than written as a range.
 */
export const WINDOWS_RESERVED_BASE_NAME = /^(con|prn|aux|nul|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * Characters no Windows file name may hold, and the control characters no file system should.
 *
 * The control-character half is the point of the rule, so the lint that objects to a control range
 * inside a character class is the rule being wrong here.
 */
// eslint-disable-next-line no-control-regex
export const WINDOWS_FORBIDDEN_CHARACTER = /[?*<>|":\u0000-\u001f\u007f]/

/**
 * Unicode characters a reader must not be allowed to hide or reorder in a file name.
 *
 * `Default_Ignorable_Code_Point` includes format characters and other code points that render as
 * nothing or as blank fillers in the launcher's Chromium. This also covers bidi controls and U+180E.
 */
export const HIDDEN_UNICODE_NAME_CHARACTER = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u

/** Makes hidden code points in an on-disk name visible in an export refusal. */
export function showDefaultIgnorables(value: string): string {
  return [...value]
    .map((character) => {
      if (!HIDDEN_UNICODE_NAME_CHARACTER.test(character)) return character
      const codePoint = character.codePointAt(0) as number
      return `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`
    })
    .join("")
}

/**
 * The segment boundary used by `assertSafeFileName` in `src/ipc/validation.ts`. Keep the shared
 * 255-character, traversal, and separator rules aligned if either helper changes.
 */
function assertSafeFileName(segment: unknown, name: string): string {
  if (typeof segment !== "string" || segment.length === 0 || segment.length > 255 || segment.includes("\0")) {
    throw new TypeError(`Invalid ${name}`)
  }
  if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
    throw new TypeError(`Invalid ${name}`)
  }
  return segment
}

/**
 * A pack key has to be a relative path of `.json` names below `ModConfig`, written the way every
 * other archive in this launcher writes one: forward slashes, because a pack is read on every
 * platform and `path.sep` would bake in the platform that exported it.
 *
 * Every segment is held to what safe file name rules allow, and the rest is what Windows adds on top
 * of that: a device name, a character it will not put in a name, a space or a dot at the end. Bidi
 * controls and invisible zero-width characters are refused too, so a pack cannot display a different
 * name to the player than the file on disk. Those are refused here rather than discovered on a Windows
 * machine by everybody else.
 *
 * @param value Key as a pack or a dialog sent it.
 * @returns The key, unchanged, once every rule has passed.
 * @throws TypeError, naming the rule that refused it.
 */
export function assertModConfigKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MOD_CONFIG_KEY_LENGTH || value.includes("\0")) {
    throw new TypeError("Invalid mod config key")
  }

  const segments = value.split("/")
  // Only the last segment is the file. The ones before it are folders, made by the game and by
  // players; holding them to the `.json` rule would refuse every nested config there is.
  const fileName = segments.at(-1) ?? ""
  if (!fileName.toLowerCase().endsWith(".json")) {
    throw new TypeError("Mod config keys must name a .json file")
  }
  // Everything ahead of the extension is the part Windows looks at when it decides whether a name
  // is a device, or is a name that differs from another in a way no file manager will show.
  const stem = fileName.slice(0, -".json".length)

  for (const segment of segments) {
    // Covers the empty segment a leading, doubled or trailing slash produces, "." and "..", the
    // backslash a pack written on Windows may carry, and anything over 255 characters.
    assertSafeFileName(segment, "mod config key")

    if (WINDOWS_FORBIDDEN_CHARACTER.test(segment) || HIDDEN_UNICODE_NAME_CHARACTER.test(segment)) {
      throw new TypeError("Invalid mod config key")
    }
    // A device name and a trailing dot or space are not visible in a file manager, so two keys that
    // differ only by one are one file on Windows and the second write is the only one to land. The
    // regex's own optional extension is what lets a folder called Client pass and a folder called
    // nul not, which is the same line Windows draws.
    const tail = segment === fileName ? stem : segment
    if (WINDOWS_RESERVED_BASE_NAME.test(segment) || /[. ]$/.test(tail)) {
      throw new TypeError("Invalid mod config key")
    }
  }

  return value
}

/**
 * Whether a key is valid for a mod config entry in a modpack.
 */
export function isValidModConfigKey(value: unknown): boolean {
  try {
    assertModConfigKey(value)
    return true
  } catch {
    return false
  }
}

/**
 * Finds all case-folded config keys that appear more than once in the list of configs.
 *
 * On Windows and macOS, two names differing only in case refer to the same file.
 * Any key whose lowercase spelling appears more than once is returned in the colliding set.
 */
export function findCollidingModConfigKeys(names: readonly string[]): Set<string> {
  const counts = new Map<string, number>()
  for (const name of names) {
    const lower = name.toLowerCase()
    counts.set(lower, (counts.get(lower) ?? 0) + 1)
  }

  const colliding = new Set<string>()
  for (const [lower, count] of counts) {
    if (count > 1) colliding.add(lower)
  }
  return colliding
}

export type ExportModConfigIssue = "hidden-character" | "bad-name" | "collides"

/**
 * Diagnoses why a config file cannot travel in a modpack by default, or undefined if it can.
 *
 * Checks hidden Unicode characters first (spelling them with code points), then bad name (if
 * Windows refuses the name entirely), then case collisions.
 */
export function diagnoseModConfigKey(name: string, collidingLower: ReadonlySet<string>): ExportModConfigIssue | undefined {
  if ([...name].some((character) => HIDDEN_UNICODE_NAME_CHARACTER.test(character))) {
    return "hidden-character"
  }
  if (!isValidModConfigKey(name)) return "bad-name"
  if (collidingLower.has(name.toLowerCase())) return "collides"
  return undefined
}
