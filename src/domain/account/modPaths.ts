/**
 * Pointing the game's mod folder list back at the installation it is launched
 * from.
 *
 * An installation copied out of another launcher, or out of a standalone
 * Vintage Story data folder, brings that folder's `clientsettings.json` with
 * it. The game writes its mod folder list there as
 * `["Mods", "<data folder>/Mods"]`: the first entry is resolved against
 * whatever `--dataPath` the process was started with, the second is the
 * absolute path of the data folder the game was running on when it wrote the
 * file. In a fresh install both name the same folder. After a copy the absolute
 * one still names the folder the file came from, so the game loads mods from
 * the old install while the launcher manages the new one (issue #396).
 *
 * ## Only the shape the game itself writes
 *
 * Repointing happens for that default list and nothing else. Two entries, the
 * relative `Mods` and one absolute path whose last segment is `Mods`, and the
 * absolute one pointing outside the installation: only then is the absolute
 * entry replaced, in place, with this installation's own Mods folder. Every
 * other list is somebody's deliberate setup, a second mod folder on another
 * drive being the obvious one, and is left exactly as found. A launcher that
 * "fixed" those would be deleting mod folders from the player's list on their
 * behalf.
 *
 * Like the session write this rides on, the document comes back with
 * everything else in it untouched, and an unchanged document comes back as the
 * very same reference so the caller can tell there is nothing to write.
 */

import { MODS_FOLDER_NAME } from "../mods/folder"
import { normalizeFolderForComparison } from "../paths"

/** Key of the section the mod folder list lives in. */
const STRING_LIST_SETTINGS_SECTION = "stringListSettings"

/** Key of the mod folder list itself, in the game's spelling. */
const MOD_PATHS_KEY = "modPaths"

/** The installation the game is about to be launched on. */
export interface ModPathsTarget {
  /** The data folder itself, which is what the game is started with as `--dataPath`. */
  installationPath: string
  /** That folder's Mods subfolder, joined by the host with its own separator. */
  modsPath: string
}

/**
 * What the mod folder list needed.
 *
 * `unchanged` covers everything that calls for no write and no word to the
 * player: no list in the file, or one already pointing at this installation.
 * `left-as-found` is the customised list, reported so the caller can say out
 * loud that it was recognised and deliberately not touched.
 */
export type RepointModPathsOutcome = "repointed" | "unchanged" | "left-as-found"

export interface RepointModPathsResult {
  /** The document to write. The same reference as the input unless `outcome` is `repointed`. */
  document: unknown
  outcome: RepointModPathsOutcome
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** True for a path the game wrote as an absolute one, on either platform. */
function isAbsoluteEntry(entry: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(entry)
}

/** True when `entry`'s last segment is the game's Mods folder name, case-insensitively on Windows. */
function endsWithModsSegment(entry: string): boolean {
  const lastSegment = normalizeFolderForComparison(entry).split("/").pop() ?? ""
  return lastSegment === (/^[a-zA-Z]:/.test(entry) ? MODS_FOLDER_NAME.toLowerCase() : MODS_FOLDER_NAME)
}

/** True when `candidate` is `root` or sits under it. */
function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeFolderForComparison(root)
  const normalizedCandidate = normalizeFolderForComparison(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

/**
 * The absolute entry of a list that has the shape the game writes, or null for
 * every other list.
 *
 * Order is not part of the shape, only the pair is: one relative `Mods` and one
 * absolute path ending in a Mods segment. The caller replaces the entry where
 * it stands, so a list written the other way round survives in its own order.
 */
function defaultShapeAbsoluteEntry(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((entry) => typeof entry === "string")) return null

  const entries = value as string[]
  const absolute = entries.filter((entry) => isAbsoluteEntry(entry) && endsWithModsSegment(entry))
  const relative = entries.filter((entry) => entry === MODS_FOLDER_NAME)
  if (absolute.length !== 1 || relative.length !== 1) return null

  return absolute[0] ?? null
}

/**
 * Gives back the document to write and what the mod folder list needed.
 *
 * @param existingDocument What the settings file held, or undefined when there was none.
 * @param target The installation the game is about to be launched on.
 */
export function repointModPaths(existingDocument: unknown, target: ModPathsTarget): RepointModPathsResult {
  const document = asRecord(existingDocument)
  const section = document && asRecord(document[STRING_LIST_SETTINGS_SECTION])
  if (!document || !section || !(MOD_PATHS_KEY in section)) return { document: existingDocument, outcome: "unchanged" }

  const absolute = defaultShapeAbsoluteEntry(section[MOD_PATHS_KEY])
  if (absolute === null) return { document: existingDocument, outcome: "left-as-found" }
  if (isWithin(target.installationPath, absolute)) return { document: existingDocument, outcome: "unchanged" }

  const repointed = (section[MOD_PATHS_KEY] as string[]).map((entry) => (entry === absolute ? target.modsPath : entry))

  return {
    document: { ...document, [STRING_LIST_SETTINGS_SECTION]: { ...section, [MOD_PATHS_KEY]: repointed } },
    outcome: "repointed"
  }
}
