/**
 * Decides whether ConfigContext's fire-and-forget SAVE_CONFIG effect should
 * say anything about a save's result, and carries just enough history to
 * tell an ongoing failure apart from a one-off blip.
 *
 * The effect fires on every config change, so a persistent failure is a
 * stream of `ok: false` results, not one. Toasting on the very first failure
 * would also toast on a single transient one that a later, newer save wipes
 * out immediately after (see the coalescing write queue in
 * config/configManager.ts, which the renderer cannot see from here) -- not
 * worth interrupting the player for. So this waits for a short streak of
 * consecutive failures before saying anything, and says it exactly once per
 * streak. Recovery is reported the same way: once, only if a failure was
 * actually shown, never on every quiet success.
 *
 * Pulled out of ConfigContext.tsx so the decision can be pinned by a test
 * without mounting the provider tree.
 */

/** Consecutive failures required before the player is told saves are failing. One bad save alone stays quiet. */
export const CONFIG_SAVE_FAILURE_STREAK_THRESHOLD = 2

export interface ConfigSaveHealthState {
  /** Consecutive `ok: false` results seen since the last success. */
  failureStreak: number
  /** Whether a "saves are failing" notice has already fired for the current streak. */
  notifiedFailing: boolean
}

export const initialConfigSaveHealthState: ConfigSaveHealthState = { failureStreak: 0, notifiedFailing: false }

export type ConfigSaveHealthNotice = { kind: "failing"; reason: SaveConfigFailureReason } | { kind: "recovered" } | null

export interface ConfigSaveHealthDecision {
  /** The state to carry into the next save result. */
  state: ConfigSaveHealthState
  /** What to tell the player, if anything, about this result. */
  notice: ConfigSaveHealthNotice
}

/**
 * Folds one SAVE_CONFIG result into the running health state.
 *
 * A success always resets the streak. It also reports `recovered`, but only
 * when a `failing` notice was actually shown first -- a streak that never
 * reached the threshold was never mentioned, so there is nothing to walk
 * back. A failure grows the streak and reports `failing` the moment the
 * streak crosses the threshold, once per streak (later failures in the same
 * streak stay quiet, since the player was already told).
 */
export function updateConfigSaveHealth(state: ConfigSaveHealthState, result: SaveConfigResult): ConfigSaveHealthDecision {
  if (result.ok) return { state: initialConfigSaveHealthState, notice: state.notifiedFailing ? { kind: "recovered" } : null }

  const failureStreak = state.failureStreak + 1
  if (failureStreak >= CONFIG_SAVE_FAILURE_STREAK_THRESHOLD && !state.notifiedFailing) {
    return { state: { failureStreak, notifiedFailing: true }, notice: { kind: "failing", reason: result.reason } }
  }
  return { state: { failureStreak, notifiedFailing: state.notifiedFailing }, notice: null }
}

/** The i18n key naming why saves are failing, in house voice, with the way out. */
export function configSaveFailureMessageKey(reason: SaveConfigFailureReason): string {
  switch (reason) {
    case "invalid-payload":
      return "notifications.body.configSaveInvalidPayload"
    case "unauthorized-path":
      return "notifications.body.configSaveUnauthorizedPath"
    case "write-failed":
      return "notifications.body.configSaveWriteFailed"
  }
}
