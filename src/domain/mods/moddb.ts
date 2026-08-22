/**
 * Interpretation of ModDB v1 API responses (`mods.vintagestory.at/api/*`).
 *
 * Every v1 endpoint answers with a real HTTP 200 whether the call succeeded or not: the
 * application-level result lives in a `statuscode` field that is itself a STRING ("200" on success,
 * "404" on a missing mod, never a bare number). `src/ipc/network.ts` only catches transport failures
 * (a non-2xx status, a timeout, an oversized body), so nothing below the renderer hooks has ever
 * looked at this field. A caller that skips it and trusts the body outright gets `undefined` back on
 * every application error, typed as whatever it asked for.
 *
 * What follows reads the envelope first, the way every v1 caller has to: deserialize, check
 * `statuscode`, only then trust the payload. It is deliberately tolerant beyond that. The catalog
 * that `/mods` returns is close to eight thousand entries maintained by hundreds of different
 * authors through a web form, not a schema, so a single odd entry is dropped rather than voiding the
 * page, the same trade-off {@link ../mods/scanInstalled} makes for a folder of archives.
 *
 * One PHP quirk this module does not yet have to handle: `/api/updates` (not called by the launcher
 * today, but a natural next caller of this file) reports its `updates` map as a JSON OBJECT when it
 * has entries and as an EMPTY ARRAY `[]` when it does not, because PHP has one type for both and
 * `json_encode` guesses from whichever is present. A future reader for that endpoint needs to accept
 * both shapes for the same field, not just an object.
 */

/** Why a v1 response could not be trusted. */
export type ModDbApiFailure = "api-error" | "malformed-response"

/**
 * The result of reading one v1 response.
 *
 * `statusCode` rides along on failure when the envelope had one to report, so a caller can log the
 * application's own reason (a "404" reads very differently from no status at all).
 */
export type ModDbResponse<T> = { ok: true; payload: T } | { ok: false; reason: ModDbApiFailure; statusCode?: string }

/** The string v1 uses to mean success. Every other value, including a missing field, is a failure. */
const SUCCESS_STATUS_CODE = "200"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True for a value the ModDB would consider filled in: a non-blank string, or anything else defined. */
function present(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null
}

/**
 * Cleans one of the ModDB's string arrays.
 *
 * `/api/mods` renders an empty tag or identifier list as `[""]`, a single empty string, rather than
 * `[]`. It is an artifact of a SQL `GROUP_CONCAT` that comes back `NULL` when there is nothing to
 * concatenate, exploded on a comma regardless of whether it held anything. `/api/mod/{id}` does not
 * share the bug for the same field on the same mod. Trimming and dropping empty entries makes the
 * two endpoints agree, and is harmless on the endpoint that never had the bug in the first place.
 */
function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Reads a v1 envelope: JSON.parse, then the `statuscode` gate, then one field of the body.
 *
 * The order is the whole point. Checking `statuscode` before trusting anything else is what makes an
 * application-level "404" distinguishable from a payload this reader does not recognise, and reading
 * the body before either is what makes both of those distinguishable from text that never was JSON.
 */
function readV1<T>(rawText: string, field: string, read: (value: unknown) => T | undefined): ModDbResponse<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { ok: false, reason: "malformed-response" }
  }

  if (!isRecord(parsed)) return { ok: false, reason: "malformed-response" }

  const statusCode = typeof parsed["statuscode"] === "string" ? parsed["statuscode"] : undefined
  if (statusCode !== SUCCESS_STATUS_CODE) return { ok: false, reason: "api-error", statusCode }

  const payload = read(parsed[field])
  return payload === undefined ? { ok: false, reason: "malformed-response", statusCode } : { ok: true, payload }
}

/** One `/api/mods` entry, tolerant of everything beyond the fields the launcher keys off. */
export interface ModDbModSummary extends Record<string, unknown> {
  modid: number
  name: string
  modidstrs: string[]
  tags: string[]
}

function readModSummary(value: unknown): ModDbModSummary | undefined {
  if (!isRecord(value)) return undefined

  const { modid, name } = value
  if (typeof modid !== "number" || typeof name !== "string" || name.trim().length === 0) return undefined

  return { ...value, modid, name, modidstrs: cleanStrings(value["modidstrs"]), tags: cleanStrings(value["tags"]) }
}

/**
 * Reads `GET /api/mods`.
 *
 * An entry with no usable `modid` or `name` is dropped rather than voiding the whole search: on a
 * catalog this size, refusing the entire list over one bad row would be worse than showing 7999 of
 * the 8000 mods that asked for it.
 */
export function parseModListResponse(rawText: string): ModDbResponse<ModDbModSummary[]> {
  return readV1(rawText, "mods", (value) => {
    if (!Array.isArray(value)) return undefined
    return value.map(readModSummary).filter((entry): entry is ModDbModSummary => entry !== undefined)
  })
}

/** One `/api/mod/{id}` result, tolerant of everything beyond the fields the launcher keys off. */
export interface ModDbModDetail extends Record<string, unknown> {
  modid: number
  name: string
}

function readModDetail(value: unknown): ModDbModDetail | undefined {
  if (!isRecord(value)) return undefined

  const { modid, name } = value
  if (typeof modid !== "number" || typeof name !== "string" || name.trim().length === 0) return undefined

  // The install popup maps `releases` directly, so a detail without the array would crash it
  // instead of reaching its failure state. Unlike modid and name this is not a field the API is
  // known to always send, hence the explicit check rather than trusting the shape.
  if (!Array.isArray(value["releases"])) return undefined

  return { ...value, modid, name }
}

/**
 * Reads `GET /api/mod/{id}`.
 *
 * A mod that does not exist answers `{"statuscode":"404"}` with no `mod` field at all, which the
 * `statuscode` gate in {@link readV1} already turns into `api-error` before this ever runs.
 */
export function parseModDetailResponse(rawText: string): ModDbResponse<ModDbModDetail> {
  return readV1(rawText, "mod", readModDetail)
}

/** One entry of a `name`-and-id list: `/api/authors`, `/api/gameversions` or `/api/tags`. */
export interface ModDbNamedEntry extends Record<string, unknown> {
  name: string
}

/**
 * Reads one list entry, requiring only that it carry a usable `name` and something under `idKey`.
 *
 * The id field is read by name rather than type-checked, because its type is not even consistent
 * across these three endpoints: `tags[].tagid` is a JSON string, `gameversions[].tagid` is a JSON
 * number far outside `int32` range. Requiring "present" rather than "a string" or "a number" is what
 * keeps this one reader correct for all three instead of rejecting two of them.
 */
function readNamedEntry(value: unknown, idKey: string): ModDbNamedEntry | undefined {
  if (!isRecord(value)) return undefined
  if (!present(value[idKey]) || !present(value["name"])) return undefined

  const { name } = value
  if (typeof name !== "string") return undefined

  return { ...value, name }
}

function readNamedList(value: unknown, idKey: string): ModDbNamedEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((entry) => readNamedEntry(entry, idKey)).filter((entry): entry is ModDbNamedEntry => entry !== undefined)
}

/** Reads `GET /api/authors`. Callers must have already narrowed the search with `?name=`. */
export function parseAuthorsResponse(rawText: string): ModDbResponse<ModDbNamedEntry[]> {
  return readV1(rawText, "authors", (value) => readNamedList(value, "userid"))
}

/** Reads `GET /api/gameversions`. */
export function parseGameVersionsResponse(rawText: string): ModDbResponse<ModDbNamedEntry[]> {
  return readV1(rawText, "gameversions", (value) => readNamedList(value, "tagid"))
}

/** Reads `GET /api/tags`. */
export function parseTagsResponse(rawText: string): ModDbResponse<ModDbNamedEntry[]> {
  return readV1(rawText, "tags", (value) => readNamedList(value, "tagid"))
}
