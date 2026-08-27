/**
 * The one-time offer to fetch the launcher's own ModDB listing archive (#219).
 *
 * The launcher is listed on the ModDB as mod 11016, where the listing holds a 315-byte pointer
 * archive rather than a build: the builds live on GitHub and always will. What that listing does
 * hold is a download counter, which is most of what decides whether anyone browsing the site ever
 * sees the launcher at all.
 *
 * Measured on our own listing before any of this was written: fetching the CDN URL directly leaves
 * the counter alone, and fetching {@link moddbListingDownloadUrl} increments it by one. So the
 * counting door is the `/download` endpoint, and nothing else.
 *
 * The rules this feature is built to, all of them deliberate:
 *  - the player is asked once, in plain words, and whichever of the three answers they give is
 *    remembered forever. There is no second ask, no retry, no "maybe later";
 *  - only {@link MODDB_VISIBILITY_ACCEPTED} fetches anything, exactly once, and only after a click;
 *  - closing the prompt without answering records nothing, so it asks again next launch rather than
 *    counting silence as either a yes or a no.
 */

/** The launcher's own entry on the ModDB. */
export const MODDB_LISTING_MOD_ID = 11016

/**
 * Where the listing's current file id is read from, at the moment the player accepts.
 *
 * Resolved rather than hardcoded because a new upload to the listing mints a new file id, and a
 * stale one would count towards an entry nobody is looking at.
 */
export const MODDB_LISTING_DETAIL_URL = `https://mods.vintagestory.at/api/mod/${MODDB_LISTING_MOD_ID}`

/** The one URL that registers a download on the listing. The CDN URL it redirects to does not. */
export function moddbListingDownloadUrl(fileId: number): string {
  return `https://mods.vintagestory.at/download?fileid=${fileId}`
}

/**
 * What the player answered.
 *
 * `unasked` is the only value that shows the prompt. `declined` and `already-done` differ only in
 * what they say about the player; both mean never ask again and never fetch anything.
 */
export type ModDbVisibilityAnswer = "unasked" | "accepted" | "declined" | "already-done"

export const MODDB_VISIBILITY_UNASKED = "unasked"
export const MODDB_VISIBILITY_ACCEPTED = "accepted"
export const MODDB_VISIBILITY_DECLINED = "declined"
export const MODDB_VISIBILITY_ALREADY_DONE = "already-done"

/** Not asked yet, and the answer anything unreadable falls back to. */
export const DEFAULT_MODDB_VISIBILITY_ANSWER: ModDbVisibilityAnswer = MODDB_VISIBILITY_UNASKED

const MODDB_VISIBILITY_ANSWERS = new Set([MODDB_VISIBILITY_UNASKED, MODDB_VISIBILITY_ACCEPTED, MODDB_VISIBILITY_DECLINED, MODDB_VISIBILITY_ALREADY_DONE])

/**
 * Anything that is not one of the four answers, missing included, becomes "not asked yet".
 *
 * Falling back to the default is the safe direction here: the worst it can do is ask a question
 * once more, where falling back to an answer would either silence a prompt nobody saw or, far
 * worse, let a hand-edited config claim a consent that was never given.
 */
export function normalizeModDbVisibilityAnswer(value: unknown): ModDbVisibilityAnswer {
  return typeof value === "string" && MODDB_VISIBILITY_ANSWERS.has(value) ? (value as ModDbVisibilityAnswer) : DEFAULT_MODDB_VISIBILITY_ANSWER
}
