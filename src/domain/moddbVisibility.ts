/**
 * The offer to count this launcher version as a download on the launcher's own ModDB listing
 * (#219, #477).
 *
 * The launcher is listed on the ModDB as mod 11016, where every release entry holds a 315-byte
 * pointer archive rather than a build: the builds live on GitHub and always will. What those
 * entries hold is a download counter each, which is most of what decides whether anyone browsing
 * the site ever sees the launcher at all.
 *
 * Measured on our own listing before any of this was written: fetching the CDN URL directly leaves
 * the counter alone, and fetching {@link moddbListingDownloadUrl} increments it by one. So the
 * counting door is the `/download` endpoint, and nothing else.
 *
 * #219 asked once per install and counted whatever entry was newest at that moment, which counted
 * players rather than downloads of a version: every later beta read as nobody having downloaded
 * it. The question now belongs to a version, and so does the count.
 *
 * The rules this feature is built to, all of them deliberate:
 *  - the prompt shows on the first launch of a version the player has not answered for, and the
 *    two lasting answers ({@link MODDB_VISIBILITY_NEVER}, {@link MODDB_VISIBILITY_ALWAYS}) are
 *    what stops it coming back at all;
 *  - nothing is fetched without an answer that says yes, and a version is counted at most once
 *    whatever the player clicks;
 *  - closing the prompt without answering records nothing, so it asks again next launch rather
 *    than counting silence as either a yes or a no;
 *  - a version whose listing entry does not exist yet counts nothing and records nothing as
 *    counted, so a later launch tries again. The entry is uploaded after the GitHub release, so
 *    the first launches of a beta routinely land before it.
 */

/** The launcher's own entry on the ModDB. */
export const MODDB_LISTING_MOD_ID = 11016

/**
 * Where the listing's releases are read from, at the moment a count is due.
 *
 * Resolved rather than hardcoded because every upload to the listing mints a new file id, and the
 * entry wanted here is the one named for the running version rather than whichever is newest.
 */
export const MODDB_LISTING_DETAIL_URL = `https://mods.vintagestory.at/api/mod/${MODDB_LISTING_MOD_ID}`

/** The one URL that registers a download on the listing. The CDN URL it redirects to does not. */
export function moddbListingDownloadUrl(fileId: number): string {
  return `https://mods.vintagestory.at/download?fileid=${fileId}`
}

/**
 * What the player last answered, and how long that answer lasts.
 *
 * `ask` is both the fresh state and "not this time": the difference between them is whether
 * {@link ModDbVisibilityState.answeredVersion} names the running version. `once` is a yes given
 * for that same version, which stays pending until the count actually lands.
 */
export type ModDbVisibilityPolicy = "ask" | "once" | "always" | "never"

export const MODDB_VISIBILITY_ASK = "ask"
export const MODDB_VISIBILITY_ONCE = "once"
export const MODDB_VISIBILITY_ALWAYS = "always"
export const MODDB_VISIBILITY_NEVER = "never"

const MODDB_VISIBILITY_POLICIES = new Set<string>([MODDB_VISIBILITY_ASK, MODDB_VISIBILITY_ONCE, MODDB_VISIBILITY_ALWAYS, MODDB_VISIBILITY_NEVER])

/** The two answers a player can give that fetch something. Nothing else may reach the counting endpoint. */
export type ModDbVisibilityConsent = typeof MODDB_VISIBILITY_ONCE | typeof MODDB_VISIBILITY_ALWAYS

export interface ModDbVisibilityState {
  policy: ModDbVisibilityPolicy
  /** The launcher version the prompt was last answered under, empty when it never was. */
  answeredVersion: string
  /** Versions whose listing entry this install has already counted, oldest first. */
  countedVersions: string[]
}

/**
 * Nobody has answered anything: what a fresh install carries, and what anything unreadable falls
 * back to.
 *
 * A function rather than a shared constant because it carries a list. Two configs normalized from
 * two unreadable documents must not end up pointing at the same array.
 */
export function defaultModDbVisibility(): ModDbVisibilityState {
  return { policy: MODDB_VISIBILITY_ASK, answeredVersion: "", countedVersions: [] }
}

/**
 * How many counted versions are kept.
 *
 * The list only has to answer "has this version been counted", and a launcher that has run twenty
 * versions on one install has long since stopped caring about the first of them. Trimming from the
 * front keeps the config a bounded size whatever happens, the same shape every other list in it
 * takes.
 */
export const MAX_COUNTED_VERSIONS = 20

/** Same ceiling `lastSeenChangelogVersion` takes in the config normalizer: a semver string with room to spare. */
const MAX_VERSION_LENGTH = 128

/** What a launch should do about the ModDB count. */
export type ModDbLaunchAction = "prompt" | "count" | "nothing"

/**
 * What this launch owes the listing, from the stored answer and the running version.
 *
 * Whether the listing actually carries an entry for that version is not an input: finding out
 * costs a request, and a request before the player has said yes is the thing this whole feature
 * exists to ask permission for. So the count is attempted and the absence handled there
 * (src/ipc/handlers/netHandlers.ts), which is also what leaves the version uncounted and retried
 * on a later launch.
 *
 * An empty running version means the launcher has not read it yet, which is neither an answer nor
 * a launch to act on.
 */
export function moddbLaunchAction(state: ModDbVisibilityState, runningVersion: string): ModDbLaunchAction {
  if (runningVersion.length === 0 || state.policy === MODDB_VISIBILITY_NEVER) return "nothing"
  if (state.countedVersions.includes(runningVersion)) return "nothing"
  if (state.policy === MODDB_VISIBILITY_ALWAYS) return "count"
  if (state.answeredVersion !== runningVersion) return "prompt"

  // Answered for this version already: a yes still owes the listing a count, anything else is done.
  return state.policy === MODDB_VISIBILITY_ONCE ? "count" : "nothing"
}

/** The state a player's answer leaves behind. The version is what stops the prompt coming back for this launcher version. */
export function answerModDbVisibility(state: ModDbVisibilityState, policy: ModDbVisibilityPolicy, runningVersion: string): ModDbVisibilityState {
  return { ...state, policy, answeredVersion: runningVersion }
}

/** Records a version as counted, capped at {@link MAX_COUNTED_VERSIONS} and never listing one twice. */
export function rememberCountedVersion(state: ModDbVisibilityState, version: string): ModDbVisibilityState {
  const countedVersions = [...state.countedVersions.filter((counted) => counted !== version), version].slice(-MAX_COUNTED_VERSIONS)
  return { ...state, countedVersions }
}

/**
 * A beta's prerelease suffix, which the listing spells differently than the launcher does.
 *
 * The ModDB rejects a `modversion` it cannot read as its own flavour of semver, so the entries are
 * named `1.7.0-pre.10` where the launcher's own version is `1.7.0-beta.10`. A stable `x.y.z` is
 * named the same on both sides and passes through untouched, and so does anything else: an entry
 * named for it simply will not be found, which is already a case this feature handles.
 */
const BETA_SUFFIX = /-beta\.(\d+)$/

/** The listing entry name for a launcher version. */
export function moddbListingVersion(version: string): string {
  return version.replace(BETA_SUFFIX, "-pre.$1")
}

/** The answers #219 stored, one string covering the whole install's lifetime. */
const LEGACY_ANSWERED = new Set(["accepted", "declined", "already-done"])
const LEGACY_ACCEPTED = "accepted"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readVersion(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_VERSION_LENGTH ? value : ""
}

function readCountedVersions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const versions = value.map(readVersion).filter((version) => version.length > 0)
  return [...new Set(versions)].slice(-MAX_COUNTED_VERSIONS)
}

/**
 * A #219 answer read as a #477 state.
 *
 * `unasked`, and anything that was never a valid answer, means nobody has been asked: the prompt
 * shows on this launch. The three real answers were given under a version nobody recorded, so they
 * are read as answers for the version running now, which is the only direction that cannot ask
 * twice about a decision the player already made, and it means the question comes back on the next
 * new version rather than on this one.
 *
 * An `accepted` also counted an entry: whichever was newest when it was answered, which on an
 * install being read today is most likely the running version's own. It is recorded as counted so
 * that switching to "always" later cannot hit that same entry a second time. A `declined` or an
 * `already-done` counted nothing here, so neither records anything.
 */
function migrateLegacyAnswer(answer: string, runningVersion: string): ModDbVisibilityState {
  if (!LEGACY_ANSWERED.has(answer)) return defaultModDbVisibility()

  return {
    policy: MODDB_VISIBILITY_ASK,
    answeredVersion: runningVersion,
    countedVersions: answer === LEGACY_ACCEPTED && runningVersion.length > 0 ? [runningVersion] : []
  }
}

/**
 * Anything unreadable becomes "nobody has answered", missing included.
 *
 * Falling back to the default is the safe direction here: the worst it can do is ask a question
 * once more, where falling back to an answer would either silence a prompt nobody saw or, far
 * worse, let a hand-edited config claim a consent that was never given. A hand-edited
 * `countedVersions` can only ever suppress a count, never cause one.
 *
 * @param value The stored field, or the #219 string it replaced.
 * @param runningVersion `app.getVersion()`, needed only to read a #219 answer.
 */
export function normalizeModDbVisibility(value: unknown, runningVersion: string): ModDbVisibilityState {
  if (typeof value === "string") return migrateLegacyAnswer(value, runningVersion)
  if (!isRecord(value)) return defaultModDbVisibility()

  const policy = value["policy"]

  return {
    policy: typeof policy === "string" && MODDB_VISIBILITY_POLICIES.has(policy) ? (policy as ModDbVisibilityPolicy) : MODDB_VISIBILITY_ASK,
    answeredVersion: readVersion(value["answeredVersion"]),
    countedVersions: readCountedVersions(value["countedVersions"])
  }
}
