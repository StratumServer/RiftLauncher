/**
 * What may leave this process as text: log lines, diagnostics, and the session report.
 *
 * The patterns live here rather than beside the logger so the domain can reach them. `logManager`
 * imports `electron-log`, which the domain may not, and duplicating a security-critical regex so a
 * pure module could have its own copy is how two redactors drift apart. `src/utils/logManager.ts`
 * re-exports `redactSensitiveText` unchanged, so every existing caller and both suites that pin it
 * (tests/log-provenance.test.ts, tests/ipc-validation.test.ts) keep importing it from where they did.
 */

const sensitiveValuePattern = /(\b(?:password|pass|sessionkey|sessionsignature|mptoken|prelogintoken|token|signature|authorization|cookie|secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi
const sensitiveQueryPattern = /([?&](?:password|pass|sessionkey|sessionsignature|mptoken|prelogintoken|token|signature|authorization|cookie|secret)=)[^&#\s]+/gi
// Keep path components that contain spaces, but only when another separator proves the space is
// still inside the path; otherwise a sentence after a path would be swallowed as part of it.
const absolutePathPattern = /(?:[A-Za-z]:[\\/]|\/(?:home|Users|mnt|tmp|var|opt|root)\/)(?:[^\s\]]+|[ \t]+(?=(?:[^\s\],.;:!?]+[ \t]+){0,8}[^\s\],.;:!?]*[\\/]))+/g

export function redactSensitiveText(message: string): string {
  return message.slice(0, 16_384).replace(sensitiveValuePattern, "$1[REDACTED]").replace(sensitiveQueryPattern, "$1[REDACTED]").replace(absolutePathPattern, "[PATH]")
}

/**
 * Shortest value this will mask.
 *
 * `redactSensitiveText` works on shape, so it can run on anything; this one works on values the
 * caller supplies, and a two-character player name would turn every word that happens to contain
 * it into `[ACCOUNT]`, which destroys the report instead of cleaning it. Vintage Story player names
 * are three characters or more, so the floor costs nothing real. A player who managed a shorter one
 * keeps it in their own report, and the paths and tokens around it are still redacted.
 */
const MIN_MASKED_VALUE_LENGTH = 3

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Masks values the pattern-based redactor cannot recognise: the player's own email address and
 * player name, which are ordinary text until you know what to look for.
 *
 * Case-insensitive, and longest first so an email that contains the player name is masked whole
 * rather than leaving its domain behind. Values shorter than {@link MIN_MASKED_VALUE_LENGTH} are
 * skipped, as are duplicates and blanks.
 */
export function maskValues(text: string, values: readonly string[]): string {
  const wanted = [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= MIN_MASKED_VALUE_LENGTH))].sort((a, b) => b.length - a.length)
  if (wanted.length === 0) return text
  return text.replace(new RegExp(wanted.map(escapeRegExp).join("|"), "gi"), "[ACCOUNT]")
}
