/**
 * Interpretation of `POST auth3.vintagestory.at/v2/gamelogin` responses.
 *
 * The endpoint is undocumented and answers a real HTTP 200 whether the login
 * succeeded or not, the same way the ModDB v1 API does (see
 * {@link ../mods/moddb}). The verdict lives in a `valid` field, and the reason
 * for a refusal in a `reason` string. A caller that trusts the body without
 * reading `valid` first gets a session object full of `undefined`.
 *
 * A login takes one pass, or two when the account has two-factor enabled: the
 * first pass answers `requiretotpcode` with a `prelogintoken`, and the second
 * carries that token back along with the six-digit code. Both passes hit the
 * same endpoint and answer with the same envelope, so most of the reading is
 * shared. What is NOT shared is what each pass may ask the caller to do next,
 * and that difference is carried in the types on purpose.
 *
 * ## No retry, by construction
 *
 * Replaying a password against an authentication service is how accounts get
 * locked, so one user action must cost at most the two passes the protocol
 * defines. Nothing here can cause a request: these functions take a response
 * and return a verdict. Beyond that, {@link interpretFirstPass} is the only one
 * that can return {@link CompleteTwoFactor}, the single verdict that asks for
 * another request, and {@link interpretSecondPass} returns
 * {@link LoginVerdict}, which has no such member. A caller that follows the
 * types cannot reach a third request, and a second pass answering
 * `requiretotpcode` again is read as a refusal rather than as an invitation to
 * try once more.
 *
 * ## What the service actually distinguishes
 *
 * Two refusal reasons are named here because the launcher has always keyed off
 * them: `requiretotpcode` and `wrongtotpcode`. Every other refusal collapses
 * into {@link BadCredentials}, including `invalidemailorpassword` and anything
 * the service might answer for a locked or throttled account. That collapse is
 * inherited, not chosen: no observed response proves this endpoint distinguishes
 * a wrong password from a rate-limited one, so naming a lockout verdict would
 * mean inventing API semantics. It stays one case until a real response says
 * otherwise.
 *
 * ## Secrets
 *
 * A success verdict carries the session credentials because the caller has to
 * store them, and a two-factor verdict carries the pre-login token because the
 * second pass has to send it back. Both stay inside the process that made the
 * request. Neither is ever put in a reason, a message, or a log line: the
 * verdicts below are the only place they appear, and the password never appears
 * at all, since interpreting a response never needs it.
 */

import { accountFieldDiagnosis, parseLoginAccount } from "./credentials"
import type { AccountCredentials } from "./credentials"

/** Refusal reason meaning the account has two-factor enabled and pass two is owed. */
const REQUIRE_TWO_FACTOR_REASON = "requiretotpcode"

/** Refusal reason meaning the six-digit code sent in pass two was wrong. */
const WRONG_TWO_FACTOR_REASON = "wrongtotpcode"

/** The session was established. */
export type LoginSuccess = { status: "success"; credentials: AccountCredentials }

/** The account has two-factor enabled and the user has not given a code yet. Terminal: ask them for one. */
export type NeedsTwoFactor = { status: "needs-two-factor" }

/**
 * The service refused, for a reason this module does not tell apart. See the
 * module note. `serverReason` carries the service's own reason string verbatim
 * (a server-side enum like "invalidemailorpassword", never user data) so the
 * host can log which refusal actually happened: the user-facing message
 * collapses them all, and field reports were undiagnosable without it.
 */
export type BadCredentials = { status: "bad-credentials"; serverReason: string }

/** The six-digit code was refused. */
export type TwoFactorRejected = { status: "two-factor-rejected" }

/**
 * The body was not JSON, not an object, or claimed success without the fields a
 * session is made of. Distinct from a refusal: the service did not say no, it
 * said something the launcher cannot act on.
 *
 * `diagnosis`, when present, names which expectation failed: a field name and
 * a type-level description of what showed up, e.g. `field "entitlements":
 * expected non-empty string, got empty string`. It never carries a value from
 * the body, so it is safe to log at error level as-is. It is only ever set
 * when {@link parseLoginAccount} is the thing that refused; a body that was
 * never valid JSON, or never an object, has nothing more specific to say.
 */
export type UnreadableResponse = { status: "unreadable-response"; diagnosis?: string }

/**
 * A verdict a login can end on.
 *
 * Deliberately holds no member that asks for another request, which is what
 * makes {@link interpretSecondPass} the end of the flow.
 */
export type LoginVerdict = LoginSuccess | NeedsTwoFactor | BadCredentials | TwoFactorRejected | UnreadableResponse

/**
 * The account has two-factor enabled and the user did give a code, so the
 * second pass is owed. Carries the token to send back with it, which the
 * service omits often enough that it is optional: the launcher has always sent
 * the second pass regardless, and the field stays optional so that behaviour is
 * preserved rather than quietly tightened.
 */
export type CompleteTwoFactor = { status: "complete-two-factor"; preLoginToken?: string }

/** What the first pass can say. The only verdict set that can ask for a second request. */
export type FirstPassVerdict = LoginVerdict | CompleteTwoFactor

/** What the caller knew before it made the first request. */
export interface FirstPassInput {
  /** True when the user filled the two-factor field, so a second pass is worth making. */
  twoFactorCodeProvided: boolean
}

const UNREADABLE: UnreadableResponse = { status: "unreadable-response" }

function readBody(rawResponse: string): Record<string, unknown> | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(rawResponse)
  } catch {
    return undefined
  }

  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
}

/**
 * True when the service said no.
 *
 * Only the three shapes of a spelled-out `0` count as a refusal. A body with no
 * `valid` field at all is NOT read as a refusal, it is read as a claim of
 * success that then has to survive {@link parseLoginAccount}: that is what the
 * launcher has always done, and turning a missing field into a refusal would
 * report "wrong password" to someone whose password was fine.
 */
function refused(body: Record<string, unknown>): boolean {
  const valid = body.valid
  return valid === 0 || valid === "0" || valid === false
}

function refusalReason(body: Record<string, unknown>): string {
  return typeof body.reason === "string" ? body.reason : ""
}

/**
 * Turns a body the service called valid into a session, or names it unreadable.
 *
 * A "valid" response missing its session key authenticates nothing, so it is
 * refused here rather than stored and written into the game's client settings
 * as a set of empty strings.
 */
function establish(email: string, body: Record<string, unknown>): LoginSuccess | UnreadableResponse {
  try {
    return { status: "success", credentials: parseLoginAccount(email, body) }
  } catch (error) {
    const diagnosis = accountFieldDiagnosis(error)
    return diagnosis ? { status: "unreadable-response", diagnosis } : UNREADABLE
  }
}

/**
 * Reads the response to the first pass.
 *
 * @param email The address the user typed, since the response does not echo it.
 * @param rawResponse The response body, exactly as it came off the wire.
 * @param input What the caller knew before asking.
 * @returns A verdict, or {@link CompleteTwoFactor} when the second pass is owed.
 */
export function interpretFirstPass(email: string, rawResponse: string, input: FirstPassInput): FirstPassVerdict {
  const body = readBody(rawResponse)
  if (!body) return UNREADABLE

  if (!refused(body)) return establish(email, body)
  if (refusalReason(body) !== REQUIRE_TWO_FACTOR_REASON) return { status: "bad-credentials", serverReason: refusalReason(body) }
  if (!input.twoFactorCodeProvided) return { status: "needs-two-factor" }

  return { status: "complete-two-factor", preLoginToken: typeof body.prelogintoken === "string" ? body.prelogintoken : undefined }
}

/**
 * Reads the response to the second pass, the one that carried the code.
 *
 * The return type ends the flow: it cannot ask for another request, so a
 * service that answers `requiretotpcode` a second time is reported as a
 * refusal instead of sending the password back out again.
 *
 * @param email The address the user typed, since the response does not echo it.
 * @param rawResponse The response body, exactly as it came off the wire.
 */
export function interpretSecondPass(email: string, rawResponse: string): LoginVerdict {
  const body = readBody(rawResponse)
  if (!body) return UNREADABLE

  if (!refused(body)) return establish(email, body)

  return refusalReason(body) === WRONG_TWO_FACTOR_REASON ? { status: "two-factor-rejected" } : { status: "bad-credentials", serverReason: refusalReason(body) }
}
