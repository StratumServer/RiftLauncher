/**
 * Maps LOGIN's internal {@link LoginVerdict} onto the {@link AccountLoginResult}
 * wire type, for every case except `success`: that one also calls
 * `saveAccountSecrets`, an async side effect this module does not touch, so it
 * stays in accountHandlers.ts.
 *
 * Pulled out for the same reason as gameExecutionOutcome.ts and
 * saveConfigOutcome.ts: accountHandlers.ts calls `ipcMain.handle` at module
 * load, which needs a running Electron main process and so cannot be imported
 * by a unit test. Nothing here touches Electron or Node, so a test can pin
 * each mapping directly.
 */

import type { UnreadableResponse } from "@domain/account/login"

/** The service refused the credentials outright. */
export function badCredentialsResult(): AccountLoginResult {
  return { status: "invalid-credentials" }
}

/** The account has two-factor enabled and the user has not supplied a code yet. */
export function needsTwoFactorResult(): AccountLoginResult {
  return { status: "requires-two-factor" }
}

/** The six-digit code was refused. */
export function twoFactorRejectedResult(): AccountLoginResult {
  return { status: "wrong-two-factor" }
}

/**
 * `unreadable-response`'s wire status, plus the message worth logging at
 * error level. Kept together because the log line is the whole point: a
 * verdict that only resolved `unexpected-response` and never logged anything
 * would leave the maintainer with no lead the next time a real success
 * payload fails to parse. The message carries `verdict.diagnosis` verbatim,
 * which is always a field name and a type-level description (see
 * `AccountFieldError` in `@domain/account/credentials`), never a value out of
 * the response body.
 */
export function unexpectedResponseOutcome(verdict: UnreadableResponse): { result: AccountLoginResult; logMessage: string } {
  return {
    result: { status: "unexpected-response" },
    logMessage: `Login response claimed success but could not be read${verdict.diagnosis ? `: ${verdict.diagnosis}` : ""}.`
  }
}

/** The credentials were accepted, but the local secret store could not be read or safely rebuilt, so nothing was saved. */
export function sessionStoreUnreadableResult(): AccountLoginResult {
  return { status: "session-store-unreadable" }
}
