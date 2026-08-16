import JSON5 from "json5"

/**
 * Reading of a mod's `modinfo.json`.
 *
 * These files are written by hand by hundreds of different authors, so the
 * reading has to be forgiving in two directions at once. JSON5 covers the
 * syntax: comments and trailing commas turn up regularly and the game accepts
 * them. Case insensitive key lookup covers the naming: `modid`, `Modid`,
 * `ModID` and `modId` all appear in the wild because the game deserialises
 * without regard for case.
 *
 * What it is not forgiving about is types. A field that arrives as something
 * other than what it should be is dropped rather than coerced, and a value
 * carrying a NUL byte is dropped outright: this text crosses IPC and ends up in
 * paths and log lines.
 */

/** Longest a free text field may be before it stops looking like metadata. */
const MAX_TEXT_LENGTH = 4_096

/** Longest an identifier-shaped field may be. */
const MAX_IDENTIFIER_LENGTH = 256

/** Longest a short enumerated field, `side` or `type`, may be. */
const MAX_KEYWORD_LENGTH = 128

/** Longest one entry of an author or contributor list may be. */
const MAX_LIST_ENTRY_LENGTH = 512

/** Most entries an author or contributor list may carry. */
const MAX_LIST_ENTRIES = 256

/** The metadata a readable `modinfo.json` describes. */
export interface ModInfo {
  name: string
  modid: string
  version: string
  description?: string
  side?: string
  authors?: string[]
  contributors?: string[]
  type?: string
}

/** Why a `modinfo.json` did not describe a mod. */
export type ModInfoProblem = "modinfo-invalid" | "modinfo-incomplete"

export type ModInfoResult = { ok: true; info: ModInfo } | { ok: false; problem: ModInfoProblem }

/** True for a string worth keeping: non empty, bounded, and free of NUL. */
function usableText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0")
}

/**
 * Reads one key regardless of how its author cased it.
 *
 * An exact match wins, so a file carrying both `modid` and `ModID` is read the
 * way its author most likely meant it. Only then does the lookup fall back to
 * the first key that matches ignoring case.
 */
function readValue(record: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(record, key)) return record[key]

  const wanted = key.toLowerCase()
  for (const candidate of Object.keys(record)) {
    if (candidate.toLowerCase() === wanted) return record[candidate]
  }

  return undefined
}

/** One string field, or undefined when it is absent or not usable text. */
function readText(record: Record<string, unknown>, key: string, maxLength = MAX_TEXT_LENGTH): string | undefined {
  const value = readValue(record, key)
  return usableText(value, maxLength) ? value : undefined
}

/**
 * One list of strings.
 *
 * A list where any entry is unusable is dropped whole rather than silently
 * shortened: half an author list is worse than none, because nothing downstream
 * would show that someone is missing.
 */
function readTextList(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = readValue(record, key)
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) return undefined

  return value.every((entry) => usableText(entry, MAX_LIST_ENTRY_LENGTH)) ? (value as string[]) : undefined
}

/** `authors` is the documented spelling, `author` a single-name shorthand some files use instead. */
function readAuthors(record: Record<string, unknown>): string[] | undefined {
  const authors = readTextList(record, "authors")
  if (authors) return authors

  const single = readText(record, "author", MAX_LIST_ENTRY_LENGTH)
  return single ? [single] : undefined
}

/**
 * Reads the metadata out of a `modinfo.json`.
 *
 * Never throws: malformed text is a result, not an exception, because a single
 * broken archive in a folder of two hundred must not cost the user the other
 * hundred and ninety-nine.
 *
 * @param text Raw file contents.
 * @returns The metadata, or why the file did not describe a mod.
 */
export function parseModInfo(text: string): ModInfoResult {
  let parsed: unknown
  try {
    parsed = JSON5.parse(text)
  } catch {
    return { ok: false, problem: "modinfo-invalid" }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, problem: "modinfo-invalid" }

  const record = parsed as Record<string, unknown>

  const name = readText(record, "name")
  const modid = readText(record, "modid", MAX_IDENTIFIER_LENGTH)
  const version = readText(record, "version", MAX_IDENTIFIER_LENGTH)

  // The launcher keys everything off these three: without them there is nothing
  // to name, nothing to match against the mod database and nothing to update.
  if (!name || !modid || !version) return { ok: false, problem: "modinfo-incomplete" }

  return {
    ok: true,
    info: {
      name,
      modid,
      version,
      description: readText(record, "description"),
      side: readText(record, "side", MAX_KEYWORD_LENGTH),
      authors: readAuthors(record),
      contributors: readTextList(record, "contributors"),
      type: readText(record, "type", MAX_KEYWORD_LENGTH)
    }
  }
}
