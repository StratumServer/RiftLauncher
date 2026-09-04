/**
 * Turns whatever the LOGIN handler caught into a short, greppable reason,
 * without ever putting the thrown message in the log.
 *
 * The login path is the one place in the launcher where a password, a
 * six-digit code and a pre-login token are all in scope at once, and the log
 * file is what players paste into bug reports (issue #352). Logging
 * `getErrorMessage(error)` there meant the log carried whatever the thrower
 * chose to put in its message: `redactSensitiveText` only catches
 * `password: value`, `password=value` and absolute paths, so a bare secret
 * sitting in prose goes straight through. Nothing on this path does that
 * today, but the message comes from code this file does not own (an HTTP
 * client that echoes the request body, a parse failure that quotes what it
 * was given, a future assertion that prints its input), so the safe property
 * is "the message never reaches the log", not "no current thrower misbehaves".
 *
 * So this maps the error onto a fixed vocabulary instead. Every value it can
 * return is either a literal spelled out here or a substring the guards below
 * prove is digits, or a screaming-snake-case identifier: nothing derived from
 * a message body, a response, or a credential can be one.
 *
 * Pure and Electron-free, so a test can pin the mapping directly, which is
 * the same reason accountLoginOutcome.ts and loginRequestBody.ts live beside
 * this file rather than inside accountHandlers.ts. It sits in the IPC layer
 * and not in `src/domain` on purpose: its whole content is knowledge of what
 * `src/ipc/network.ts` and `src/ipc/accountStore.ts` throw, and the domain is
 * not allowed to know either of those exists.
 */

/**
 * The messages the login path's own code throws, mapped to their reason.
 *
 * A lookup, not a pattern match: these are literals thrown by
 * `requestBoundedTextViaNode` and `assertSecureStorage`, and matching them
 * exactly means an unrecognised message falls through to `unclassified-*`
 * rather than being mislabelled. If one of those strings is ever reworded,
 * the reason degrades to `unclassified-Error` and this table needs the new
 * wording; nothing breaks and no secret escapes in the meantime.
 */
const KNOWN_MESSAGES = new Map<string, string>([
  ["Network request timed out", "timeout"],
  ["Network response is too large", "response-too-large"],
  ["Network response was aborted", "response-aborted"],
  ["Secure account storage is unavailable", "secure-storage-unavailable"],
  ["A system password store is required for account storage", "no-system-password-store"]
])

/** `Network request failed with status 503`. Only the three digits, or the literal `unknown`, are carried over. */
const STATUS_MESSAGE = /^Network request failed with status (\d{3}|unknown)$/

/**
 * Node's system error codes (`ENOTFOUND`, `ECONNRESET`, `CERT_HAS_EXPIRED`).
 *
 * `code` is a public, writable property, so an error from elsewhere could
 * carry anything at all in it. Anchored and length-capped for that reason:
 * an identifier-shaped code is a Node enum member, and a value that is not
 * identifier-shaped is not one and is dropped.
 */
const SYSTEM_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/

/** Same argument as {@link SYSTEM_ERROR_CODE}, for `name`, which is writable too. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/

function systemErrorCode(error: Error): string | undefined {
  const code: unknown = (error as { code?: unknown }).code
  return typeof code === "string" && SYSTEM_ERROR_CODE.test(code) ? code : undefined
}

/**
 * @param error Whatever the LOGIN handler's catch received.
 * @returns One token naming what went wrong, safe to log verbatim.
 */
export function loginFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return "non-error-throw"

  const known = KNOWN_MESSAGES.get(error.message)
  if (known) return known

  const status = STATUS_MESSAGE.exec(error.message)
  if (status) return `http-status-${status[1]}`

  const code = systemErrorCode(error)
  if (code) return `network-${code}`

  // Nothing recognised the message, so the class name is all that is left.
  // It still separates a thrown TypeError from a failed keyring call, which
  // is the difference a maintainer reading a field report needs first.
  return ERROR_NAME.test(error.name) ? `unclassified-${error.name}` : "unclassified"
}
