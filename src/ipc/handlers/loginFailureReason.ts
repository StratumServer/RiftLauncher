/**
 * Turns whatever the LOGIN handler caught into a short, greppable reason,
 * without ever putting anything the error carries in the log.
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
 * return is a literal spelled out in this file, with nothing interpolated
 * into it. `code` and `name` are both public and writable, so a value that
 * merely looks like a Node enum member proves nothing about where it came
 * from: they are read as lookup keys into the tables below and never copied
 * into the answer. An HTTP status is parsed out of the message as a number
 * and then used the same way, because the message is written from the
 * response and a status the caller can influence is no safer than a field the
 * thrower can set. A key that is not in a table maps to that table's
 * catch-all token.
 *
 * The other half of the answer is where the error came from. The handler's
 * catch wraps two very different things: the network round trip and the
 * account-store write. `AccountStorageFailure` is the marker that keeps them
 * apart, so a full disk is never reported as a network problem.
 *
 * Pure and Electron-free, so a test can pin the mapping directly, which is
 * the same reason accountLoginOutcome.ts and loginRequestBody.ts live beside
 * this file rather than inside accountHandlers.ts. It sits in the IPC layer
 * and not in `src/domain` on purpose: its whole content is knowledge of what
 * `src/ipc/network.ts` and `src/ipc/accountStore.ts` throw, and the domain is
 * not allowed to know either of those exists.
 */

/**
 * Marks an error as raised by the account-store write rather than by the
 * network, so {@link loginFailureReason} classifies it against the storage
 * tables. `accountHandlers.ts` wraps at the one call site that touches the
 * store, which is the only place that can know the origin for certain: by the
 * time the outer catch sees the error, a bare `ENOSPC` from a keyring write
 * and an `ENOSPC` from a socket look exactly alike.
 */
export class AccountStorageFailure extends Error {
  constructor(cause: unknown) {
    super("Account storage failed", { cause })
    this.name = "AccountStorageFailure"
  }
}

/**
 * The network messages the login path's own code throws, mapped to their reason.
 *
 * A lookup, not a pattern match: these are literals thrown by
 * `requestBoundedTextViaNode`, and matching them exactly means an
 * unrecognised message falls through to `unclassified` rather than being
 * mislabelled. If one of those strings is ever reworded, the reason degrades
 * to `unclassified-Error` and this table needs the new wording; nothing
 * breaks and no secret escapes in the meantime.
 */
const NETWORK_MESSAGES = new Map<string, string>([
  ["Network request timed out", "timeout"],
  ["Network response is too large", "response-too-large"],
  ["Network response was aborted", "response-aborted"]
])

/** The literals `assertSecureStorage` throws, reached through {@link AccountStorageFailure}. */
const STORAGE_MESSAGES = new Map<string, string>([
  ["Secure account storage is unavailable", "secure-storage-unavailable"],
  ["A system password store is required for account storage", "no-system-password-store"]
])

/** `Network request failed with status 503`. The digits are read as a number, never carried over as text. */
const STATUS_MESSAGE = /^Network request failed with status (\d{3}|unknown)$/

/**
 * The HTTP statuses the auth service actually answers with, each mapped to
 * the token that names it.
 *
 * Not `http-status-${status}`: `network.ts` writes that message from the
 * response's own status line, and `assertString` accepts `503` as a password,
 * so a login with that password and an outage on the other end used to put
 * the password in the log. The status is parsed into a number here and then
 * treated exactly like `code`, as a lookup key whose value never reaches the
 * answer. A status outside the table degrades to its range, which still
 * separates "the service rejected us" from "the service is broken", and
 * anything that is not a 4xx or 5xx (a redirect this transport does not
 * follow, or the literal `unknown` when the response had no status line at
 * all) is `http-other`.
 */
const HTTP_STATUSES = new Map<number, string>([
  [400, "http-bad-request"],
  [401, "http-unauthorized"],
  [403, "http-forbidden"],
  [404, "http-not-found"],
  [408, "http-request-timeout"],
  [429, "http-rate-limited"],
  [500, "http-server-error"],
  [502, "http-bad-gateway"],
  [503, "http-unavailable"],
  [504, "http-gateway-timeout"]
])

/**
 * The socket and TLS failures the login round trip can actually surface,
 * each mapped to the token that names it.
 *
 * The values are literals, not the key spliced into a prefix: `code` is a
 * writable property, so `Object.assign(new Error("boom"), { code: secret })`
 * must not be able to put anything in the log even when the secret happens to
 * be shaped like a Node enum member. Being in this table is what makes a
 * value loggable, and what is logged is this table's own string.
 *
 * The socket codes are what `http(s).request` reports on `error` for a DNS,
 * routing or peer failure. The TLS ones are on the list because the login
 * pass goes to `https://auth3.vintagestory.at` through the Node transport
 * (see `requestBoundedTextViaNode`), so a certificate this machine will not
 * accept, most often a corporate middlebox or a clock that is badly wrong,
 * arrives on the same `error` event as the rest.
 */
const NETWORK_CODES = new Map<string, string>([
  ["ENOTFOUND", "network-ENOTFOUND"],
  ["EAI_AGAIN", "network-EAI_AGAIN"],
  ["ECONNREFUSED", "network-ECONNREFUSED"],
  ["ECONNRESET", "network-ECONNRESET"],
  ["ECONNABORTED", "network-ECONNABORTED"],
  ["EPIPE", "network-EPIPE"],
  ["ETIMEDOUT", "network-ETIMEDOUT"],
  ["EHOSTUNREACH", "network-EHOSTUNREACH"],
  ["ENETUNREACH", "network-ENETUNREACH"],
  ["ENETDOWN", "network-ENETDOWN"],
  ["EPROTO", "network-EPROTO"],
  ["ERR_SOCKET_CONNECTION_TIMEOUT", "network-ERR_SOCKET_CONNECTION_TIMEOUT"],
  ["ERR_STREAM_PREMATURE_CLOSE", "network-ERR_STREAM_PREMATURE_CLOSE"],
  ["CERT_HAS_EXPIRED", "network-CERT_HAS_EXPIRED"],
  ["CERT_NOT_YET_VALID", "network-CERT_NOT_YET_VALID"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "network-UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "network-UNABLE_TO_GET_ISSUER_CERT_LOCALLY"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "network-SELF_SIGNED_CERT_IN_CHAIN"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "network-DEPTH_ZERO_SELF_SIGNED_CERT"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "network-ERR_TLS_CERT_ALTNAME_INVALID"]
])

/**
 * What the account-store write reports when the filesystem refuses it.
 *
 * Grouped rather than listed one for one: the maintainer's question after a
 * failed save is "is the disk full, is it a permissions problem, or is it
 * something else", and three answers cover it. Same rule as
 * {@link NETWORK_CODES}, the value logged is this table's string.
 */
const STORAGE_CODES = new Map<string, string>([
  ["ENOSPC", "storage-no-space"],
  ["EDQUOT", "storage-no-space"],
  ["EFBIG", "storage-no-space"],
  ["EACCES", "storage-permission"],
  ["EPERM", "storage-permission"],
  ["EROFS", "storage-permission"],
  ["EBUSY", "storage-locked"],
  ["ETXTBSY", "storage-locked"],
  ["EIO", "storage-io"],
  ["EMFILE", "storage-other"],
  ["ENFILE", "storage-other"]
])

/**
 * The built-in error classes worth telling apart when nothing else matched.
 *
 * `name` is writable too, so this is a lookup and not a pattern: an error
 * whose name is a valid-format credential is not in this table and becomes
 * plain `unclassified`. Keeping the handful that are here is what still
 * separates a bug in our own parsing (a `TypeError`) from a call the user
 * cancelled (an `AbortError`).
 */
const ERROR_NAMES = new Map<string, string>([
  ["Error", "unclassified-Error"],
  ["TypeError", "unclassified-TypeError"],
  ["RangeError", "unclassified-RangeError"],
  ["SyntaxError", "unclassified-SyntaxError"],
  ["ReferenceError", "unclassified-ReferenceError"],
  ["AbortError", "unclassified-AbortError"]
])

/** Names an HTTP failure without ever formatting the status back into a string. */
function httpReason(status: string | undefined): string {
  const code = Number(status) // `unknown` and a missing group are both NaN, and every comparison below is false for NaN.
  const named = HTTP_STATUSES.get(code)
  if (named) return named
  if (code >= 400 && code < 500) return "http-4xx"
  if (code >= 500 && code < 600) return "http-5xx"

  return "http-other"
}

/** The `code` an error carries, as a lookup key only: a non-string is no key at all. */
function codeOf(error: Error): string {
  const code: unknown = (error as { code?: unknown }).code
  return typeof code === "string" ? code : ""
}

/** Classifies what the account-store write threw, never as a network failure. */
function storageReason(cause: unknown): string {
  if (!(cause instanceof Error)) return "storage-other"

  return STORAGE_MESSAGES.get(cause.message) ?? STORAGE_CODES.get(codeOf(cause)) ?? "storage-other"
}

/**
 * @param error Whatever the LOGIN handler's catch received.
 * @returns One token naming what went wrong, safe to log verbatim.
 */
export function loginFailureReason(error: unknown): string {
  if (error instanceof AccountStorageFailure) return storageReason(error.cause)
  if (!(error instanceof Error)) return "non-error-throw"

  const known = NETWORK_MESSAGES.get(error.message)
  if (known) return known

  const status = STATUS_MESSAGE.exec(error.message)
  if (status) return httpReason(status[1])

  const code = codeOf(error)
  if (code) return NETWORK_CODES.get(code) ?? "network-other"

  // Nothing recognised the message, so the class is all that is left. It
  // still separates a thrown TypeError from anything else, which is the
  // difference a maintainer reading a field report needs first.
  return ERROR_NAMES.get(error.name) ?? "unclassified"
}
