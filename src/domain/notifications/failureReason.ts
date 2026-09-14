/**
 * Why something failed, said in the launcher's words rather than the system's.
 *
 * A failed row in the Activity Center used to read "An error occurred" for
 * every failure it could possibly show, while the thing that failed knew
 * perfectly well why: a refused connection, a full drive, a folder it may not
 * write to. The audit (`docs/notes/notifications-audit.md`) called that the
 * least useful line in the panel.
 *
 * The catch site knows only a raw error, and a raw error is the one thing that
 * must never reach a player: it is untranslated, it carries paths and host
 * names, and it is written for whoever wrote the library. So it is turned into
 * one of the tokens below here, once, and the token is what a record carries.
 * The screen then reads a locale string picked by that token, which is why
 * {@link failureReasonKey} is the only way to get from one to the other.
 */
export type FailureReason = "network" | "no-space" | "no-permission" | "missing-file" | "damaged-archive" | "timed-out" | "unsupported-platform" | "unknown"

/**
 * Needles looked for in the text of a failure, first match wins.
 *
 * Order matters where one cause can be read as another. A timed-out installer
 * says so in its own words and must not fall through to the generic timeout
 * further down, and a missing installer is a missing file rather than a failed
 * install.
 *
 * These are matched against the message rather than a structured code on
 * purpose: an error crossing the IPC boundary arrives as text, with the
 * original message wrapped in the remote-call one, and its `code` does not
 * survive the trip.
 */
const REASON_NEEDLES: ReadonlyArray<readonly [string, FailureReason]> = [
  // What the installer handler reports through InstallerRunResult.
  ["installer-timed-out", "timed-out"],
  ["installer-missing", "missing-file"],
  ["not-windows", "unsupported-platform"],
  // Disk and permissions, which a player can actually do something about.
  ["ENOSPC", "no-space"],
  ["EDQUOT", "no-space"],
  ["EACCES", "no-permission"],
  ["EPERM", "no-permission"],
  ["EROFS", "no-permission"],
  ["EMFILE", "no-permission"],
  // The network, in every spelling the stack uses for it.
  ["ENOTFOUND", "network"],
  ["EAI_AGAIN", "network"],
  ["ECONNREFUSED", "network"],
  ["ECONNRESET", "network"],
  ["ECONNABORTED", "network"],
  ["ENETUNREACH", "network"],
  ["EHOSTUNREACH", "network"],
  ["ERR_INTERNET_DISCONNECTED", "network"],
  ["ERR_NAME_NOT_RESOLVED", "network"],
  ["ERR_CONNECTION_REFUSED", "network"],
  ["getaddrinfo", "network"],
  ["ETIMEDOUT", "timed-out"],
  ["ESOCKETTIMEDOUT", "timed-out"],
  // An archive that will not open. The task runners throw these sentences themselves.
  ["Extraction failed", "damaged-archive"],
  ["end of central directory", "damaged-archive"],
  ["invalid or unsupported zip", "damaged-archive"],
  ["invalid signature", "damaged-archive"]
]

/**
 * The token that names why something failed, or `unknown` when nothing in it
 * can be recognised. Never returns anything derived from the error's own words.
 */
export function classifyFailure(error: unknown): FailureReason {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: unknown })?.message ?? "")
  for (const [needle, reason] of REASON_NEEDLES) if (message.includes(needle)) return reason
  return "unknown"
}

/**
 * The locale key that says a reason in a sentence. The single door between a
 * token and the screen, so nothing can put a raw error on a row by accident.
 */
export function failureReasonKey(reason: FailureReason | undefined): string {
  return "components.activityCenter.failureReasons." + (reason ?? "unknown")
}
