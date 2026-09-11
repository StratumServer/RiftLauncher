import { MAX_MOD_ARCHIVES, renameModArchiveTo } from "./scanInstalled"

/**
 * Mod profiles: named sets of the Mods that are on in one Installation (#287, #339).
 *
 * A profile is applied by renaming archives in place (X.zip to X.zip.disabled and back) until the
 * Mods folder matches it, so it costs no disk. The folder stays the only record of what is on right
 * now: the active profile's stored set is refreshed only when the player switches away from it,
 * creates a profile, or duplicates it. Installs, updates, imports, deletions and hand toggles
 * therefore change the active profile with no bookkeeping of their own, and nothing can drift.
 *
 * The profiles live in a small file at the Installation's root, so they travel with backups,
 * restores and copies, and older launchers never open it.
 */

/** The profiles file, at the root of the Installation it describes. The host joins it, never the renderer. */
export const MOD_PROFILES_FILE_NAME = "riftlauncher-mod-profiles.json"

/**
 * The only format this build reads or writes. A later additive change bumps it, so an older build
 * refuses to write a newer file instead of dropping the fields it does not know.
 */
export const MOD_PROFILES_FORMAT = 1

/** Bounds the file, nothing more. */
export const MAX_MOD_PROFILES = 50

export const MAX_MOD_PROFILE_NAME_LENGTH = 64

const MAX_MOD_PROFILE_ID_LENGTH = 64
const MAX_MODID_LENGTH = 256
const MAX_FILE_NAME_LENGTH = 255

/**
 * The largest profiles file the host will read, and so the largest it will write. The caps above do
 * not keep a document under it (50 full profiles of ordinary names come to about 10 MiB), so a save
 * that would outgrow it is refused rather than written as a file the next read turns down.
 */
export const MAX_MOD_PROFILES_FILE_BYTES = 4 * 1024 * 1024

/** What a duplicate's name ends with, before any number that keeps it unique. */
const COPY_SUFFIX = " copy"

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
const PROFILE_ID = /^[A-Za-z0-9-]+$/

/** The only thing a profile needs to know about a scanned archive. */
export type ProfileScannedMod = Readonly<{ modid: string; path: string; enabled: boolean }>

/** A profiles file this build must leave alone: from a newer launcher, or not a profiles document at all. */
export type ModProfilesProblem = "newer-format" | "unreadable"

export type ModProfilesNormalized = { ok: true; document: ModProfilesDocument } | { ok: false; problem: ModProfilesProblem }

/** Why a profile name was turned down. Fixed tokens, one message each. */
export type ModProfileNameProblem = "empty" | "too-long" | "control-character" | "taken"

export type ModProfileNameCheck = { ok: true; name: string } | { ok: false; problem: ModProfileNameProblem }

/** What applying a profile to the folder takes: the renames, and what it had to leave alone. */
export interface ModProfileSwitchPlan {
  /** Only archives in the wrong state, each with the state it has to take. Scanned paths only. */
  changes: { path: string; enabled: boolean }[]
  /** Mods the profile lists that the folder no longer holds. */
  missing: number
  /** Mods with two or more archives in the folder, none of which is the one the profile recorded. */
  unresolved: number
}

export function emptyModProfilesDocument(): ModProfilesDocument {
  return { format: MOD_PROFILES_FORMAT, activeProfileId: null, profiles: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The last segment of a path, split on either separator: the renderer never has Node's path module,
 * and a Windows path reaches it with backslashes.
 */
export function lastPathSegment(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/** The name an archive has when it is on, whichever state it is in now. */
function enabledFormOf(path: string): string {
  const fileName = lastPathSegment(path)
  const rename = renameModArchiveTo(fileName, true)
  return rename.ok ? rename.fileName : fileName
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The name rules on their own, without the uniqueness a whole document adds. */
function checkNameShape(value: string): ModProfileNameCheck {
  const name = value.trim()
  if (name.length === 0) return { ok: false, problem: "empty" }
  if (name.length > MAX_MOD_PROFILE_NAME_LENGTH) return { ok: false, problem: "too-long" }
  if (CONTROL_CHARACTER.test(name)) return { ok: false, problem: "control-character" }
  return { ok: true, name }
}

/**
 * Checks a name the player typed, trimmed: 1 to 64 characters, no control characters, and no other
 * profile of this Installation with the same name in any case.
 *
 * @param exceptId The profile being renamed, which may keep its own name in another case.
 */
export function validateModProfileName(value: string, profiles: readonly ModProfile[], exceptId?: string): ModProfileNameCheck {
  const shape = checkNameShape(value)
  if (!shape.ok) return shape
  if (profiles.some((profile) => profile.id !== exceptId && sameName(profile.name, shape.name))) return { ok: false, problem: "taken" }
  return shape
}

/** One recorded Mod, or undefined when any field breaks the file's rules. Stored names are only ever compared, never made into paths. */
function normalizeEntry(value: unknown): ModProfileEntry | undefined {
  if (!isRecord(value)) return undefined
  const { modid, file } = value
  if (typeof modid !== "string" || modid.length === 0 || modid.length > MAX_MODID_LENGTH || modid.includes("\0")) return undefined
  if (typeof file !== "string" || file.length === 0 || file.length > MAX_FILE_NAME_LENGTH || file.includes("\0")) return undefined
  if (file === "." || file === ".." || file.includes("/") || file.includes("\\") || !file.toLowerCase().endsWith(".zip")) return undefined
  return { modid, file }
}

function normalizeProfile(value: unknown): ModProfile | undefined {
  if (!isRecord(value) || !Array.isArray(value.mods)) return undefined
  const { id, name } = value
  if (typeof id !== "string" || id.length > MAX_MOD_PROFILE_ID_LENGTH || !PROFILE_ID.test(id)) return undefined
  if (typeof name !== "string") return undefined
  const shape = checkNameShape(name)
  if (!shape.ok) return undefined

  const mods = value.mods.flatMap((entry) => normalizeEntry(entry) ?? []).slice(0, MAX_MOD_ARCHIVES)
  return { id, name: shape.name, mods }
}

/**
 * Reads a profiles document as this build understands it. Never throws.
 *
 * A missing file (`undefined`) is an empty document. A newer format is refused as it stands, so an
 * older build never writes back a lossy copy of it. Anything that is not a format-1 document is
 * unreadable, and is left alone for the same reason. Inside a format-1 document the rules are
 * tolerant: a malformed profile or entry is dropped, the first of two profiles sharing an id or a
 * name (in any case) wins, the counts are cut to the caps, and an active id naming nobody is cleared.
 */
export function normalizeModProfilesDocument(value: unknown): ModProfilesNormalized {
  if (value === undefined) return { ok: true, document: emptyModProfilesDocument() }
  if (!isRecord(value)) return { ok: false, problem: "unreadable" }
  if (typeof value.format === "number" && Number.isInteger(value.format) && value.format > MOD_PROFILES_FORMAT) return { ok: false, problem: "newer-format" }
  if (value.format !== MOD_PROFILES_FORMAT) return { ok: false, problem: "unreadable" }

  const profiles: ModProfile[] = []
  for (const candidate of Array.isArray(value.profiles) ? value.profiles : []) {
    const profile = normalizeProfile(candidate)
    if (!profile) continue
    if (profiles.some((kept) => kept.id === profile.id || sameName(kept.name, profile.name))) continue
    profiles.push(profile)
    if (profiles.length === MAX_MOD_PROFILES) break
  }

  const activeProfileId = profiles.some((profile) => profile.id === value.activeProfileId) ? (value.activeProfileId as string) : null
  return { ok: true, document: { format: MOD_PROFILES_FORMAT, activeProfileId, profiles } }
}

/** What a profile records of the folder: every Mod that is on, by modid and file name. */
export function captureModProfile(mods: readonly ProfileScannedMod[]): ModProfileEntry[] {
  return mods.filter((mod) => mod.enabled).map((mod) => ({ modid: mod.modid, file: lastPathSegment(mod.path) }))
}

/**
 * The fewest renames that make the folder match `profile`.
 *
 * A Mod is matched on its modid, in any case, so a profile survives an update that changes the file
 * name. Only when two or more archives share a modid does the recorded file name choose between
 * them; if it names none of them, they are all left as they are, because guessing on a folder the
 * player arranged by hand is not the launcher's call. Anything already in the right state is not
 * touched, so applying a profile twice renames nothing the second time.
 */
export function planModProfileSwitch(profile: ModProfile, mods: readonly ProfileScannedMod[]): ModProfileSwitchPlan {
  const recorded = new Map<string, Set<string>>()
  for (const entry of profile.mods) {
    const key = entry.modid.toLowerCase()
    recorded.set(key, (recorded.get(key) ?? new Set()).add(entry.file))
  }

  const folder = new Map<string, ProfileScannedMod[]>()
  for (const mod of mods) {
    const key = mod.modid.toLowerCase()
    folder.set(key, [...(folder.get(key) ?? []), mod])
  }

  const wanted = new Map<string, boolean>()
  let unresolved = 0
  for (const [key, copies] of folder) {
    const files = recorded.get(key)
    if (!files) {
      for (const mod of copies) wanted.set(mod.path, false)
    } else if (copies.length === 1) {
      for (const mod of copies) wanted.set(mod.path, true)
    } else if (copies.some((mod) => files.has(enabledFormOf(mod.path)))) {
      // X.zip and X.zip.disabled can never both be on, and the host refuses a rename onto a taken
      // name: the copy already holding the recorded name keeps it, and its twin stays off.
      const names = new Set(copies.map((mod) => lastPathSegment(mod.path)))
      for (const mod of copies) wanted.set(mod.path, files.has(enabledFormOf(mod.path)) && (mod.enabled || !names.has(enabledFormOf(mod.path))))
    } else {
      unresolved++
    }
  }

  const changes = mods.flatMap((mod) => {
    const enabled = wanted.get(mod.path)
    return enabled === undefined || enabled === mod.enabled ? [] : [{ path: mod.path, enabled }]
  })
  const missing = [...recorded.keys()].filter((key) => !folder.has(key)).length

  return { changes, missing, unresolved }
}

/** Records the folder into the active profile, if there is one. */
function recordActive(document: ModProfilesDocument, mods: readonly ProfileScannedMod[]): ModProfilesDocument {
  if (document.activeProfileId === null) return document
  const live = captureModProfile(mods)
  return { ...document, profiles: document.profiles.map((profile) => (profile.id === document.activeProfileId ? { ...profile, mods: live } : profile)) }
}

/**
 * Saves the folder as a new profile and makes it the active one. The profile that was active until
 * now keeps what the folder held, in the same write, since that is the last time it was its record.
 */
export function createModProfile(document: ModProfilesDocument, id: string, name: string, mods: readonly ProfileScannedMod[]): ModProfilesDocument {
  const recorded = recordActive(document, mods)
  return { ...recorded, activeProfileId: id, profiles: [...recorded.profiles, { id, name, mods: captureModProfile(mods) }] }
}

/** Changes the name only: no archive, and not which profile is active. */
export function renameModProfile(document: ModProfilesDocument, id: string, name: string): ModProfilesDocument {
  return { ...document, profiles: document.profiles.map((profile) => (profile.id === id ? { ...profile, name } : profile)) }
}

/** Removes the record only. Deleting the active profile leaves the folder as it is and no profile active. */
export function deleteModProfile(document: ModProfilesDocument, id: string): ModProfilesDocument {
  return { ...document, activeProfileId: document.activeProfileId === id ? null : document.activeProfileId, profiles: document.profiles.filter((profile) => profile.id !== id) }
}

/** "<name> copy", then "<name> copy 2" and up, cut so the whole name still fits. */
function copyName(name: string, profiles: readonly ModProfile[]): string {
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? COPY_SUFFIX : `${COPY_SUFFIX} ${number}`
    const candidate = `${name.slice(0, MAX_MOD_PROFILE_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`
    if (!profiles.some((profile) => sameName(profile.name, candidate))) return candidate
  }
}

/**
 * Adds a copy of one profile, not activated. The copy of the active profile takes the folder as it
 * is, because that, not its stored set, is what the active profile holds.
 */
export function duplicateModProfile(document: ModProfilesDocument, sourceId: string, id: string, mods: readonly ProfileScannedMod[]): ModProfilesDocument {
  const source = document.profiles.find((profile) => profile.id === sourceId)
  if (!source) return document
  const copied = sourceId === document.activeProfileId ? captureModProfile(mods) : source.mods.map((entry) => ({ ...entry }))
  return { ...document, profiles: [...document.profiles, { id, name: copyName(source.name, document.profiles), mods: copied }] }
}

/**
 * The first write of a switch: the outgoing profile takes the folder as it is, and no profile is
 * active. Until the renames are all done the folder belongs to nobody, so a switch that stops half
 * way can never be recorded into either profile by the next one.
 */
export function beginModProfileSwitch(document: ModProfilesDocument, mods: readonly ProfileScannedMod[]): ModProfilesDocument {
  return { ...recordActive(document, mods), activeProfileId: null }
}

/** The last write of a switch, once every rename went through. */
export function finishModProfileSwitch(document: ModProfilesDocument, id: string): ModProfilesDocument {
  return { ...document, activeProfileId: id }
}
