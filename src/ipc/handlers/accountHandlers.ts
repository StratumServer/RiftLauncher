import { ipcMain } from "electron"

import { interpretFirstPass, interpretSecondPass } from "@domain/account/login"
import type { LoginVerdict } from "@domain/account/login"
import { badCredentialsResult, needsTwoFactorResult, twoFactorRejectedResult, unexpectedResponseOutcome } from "@src/ipc/handlers/accountLoginOutcome"
import { buildLoginRequestBody } from "@src/ipc/handlers/loginRequestBody"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { requestBoundedTextViaNode } from "@src/ipc/network"
import { assertString, MAX_LOGIN_RESPONSE_BYTES } from "@src/ipc/validation"
import { removeAccountSecrets, saveAccountSecrets } from "@src/ipc/accountStore"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

const LOGIN_URL = new URL("https://auth3.vintagestory.at/v2/gamelogin")

/**
 * Sends one login pass and hands back the raw body.
 *
 * Reading the body is `@domain/account/login`'s job, so this function has no
 * opinion about what came back and cannot decide to ask again. The URL is
 * allow-listed in `src/ipc/validation.ts` and the response is size-capped, both
 * unchanged from before the interpretation moved out.
 *
 * This goes through `requestBoundedTextViaNode`, not `requestBoundedText`:
 * the auth service refuses credential posts carrying the browser fetch
 * metadata Electron's `net.request` attaches (issue #76), so the login pass
 * needs the Node `https` transport. Every other caller of `requestBoundedText`
 * is untouched.
 *
 * The password is a parameter and nothing else: it is never held in a field,
 * never logged, and never survives the call.
 */
async function requestLoginPass(email: string, password: string, twoFactorCode?: string, preLoginToken?: string): Promise<string> {
  const body = buildLoginRequestBody(email, password, twoFactorCode, preLoginToken)

  return await requestBoundedTextViaNode(LOGIN_URL, { method: "POST", body: body.toString(), maxBytes: MAX_LOGIN_RESPONSE_BYTES })
}

/**
 * Turns a domain verdict into the answer the renderer expects, storing the
 * session on the way through when there is one.
 *
 * The secrets go straight from the verdict into the encrypted store and stop
 * there. Only the public half rides back over IPC.
 *
 * `unreadable-response` used to be thrown here, which the caller's catch
 * block collapsed into the same generic failure as everything else, and the
 * renderer's own catch turned that into "invalid email or password". That lie
 * is why this case now resolves instead of throwing: `unexpected-response`
 * tells the renderer the credentials were never actually refused, and the
 * verdict's diagnosis (a field name and a type, never a value, see
 * {@link ../../domain/account/login}) goes to the log at error level so the
 * next occurrence leaves a trail.
 */
async function settle(verdict: LoginVerdict): Promise<AccountLoginResult> {
  switch (verdict.status) {
    case "success":
      // Keyed by the uid this same response just carried, so the store can never
      // disagree with what the renderer is told. Logging into an account already
      // saved overwrites its entry in place: a session refresh, not a duplicate.
      await saveAccountSecrets(verdict.credentials.publicAccount.playerUid, verdict.credentials.secrets)
      return { status: "success", account: verdict.credentials.publicAccount }
    case "needs-two-factor":
      return needsTwoFactorResult()
    case "two-factor-rejected":
      return twoFactorRejectedResult()
    case "bad-credentials":
      // The toast collapses every refusal into "invalid email or password"; the
      // service's own reason string is the only way to tell a real credential
      // mismatch from anything else it may refuse for. Server enum, never user data.
      logMessage("debug", `[back] [ipc] [accountHandlers.ts] [LOGIN] Service refused the login, reason: "${verdict.serverReason}".`)
      return badCredentialsResult()
    case "unreadable-response": {
      const outcome = unexpectedResponseOutcome(verdict)
      logMessage("error", `[back] [ipc] [accountHandlers.ts] [LOGIN] ${outcome.logMessage}`)
      return outcome.result
    }
  }
}

/**
 * Runs the login protocol: one pass, or two when the account has two-factor
 * enabled and the user supplied a code.
 *
 * There is no retry, and the shape of the flow is what rules one out. The
 * second pass runs only when the domain answers `complete-two-factor`, which
 * only the first pass can answer, and `interpretSecondPass` returns a verdict
 * type with no member that could ask for a third. Adding one would mean
 * changing the domain types, not slipping a loop in here.
 */
ipcMain.handle(IPC_CHANNELS.ACCOUNT_MANAGER.LOGIN, async (event, email: unknown, password: unknown, twoFactorCode: unknown): Promise<AccountLoginResult> => {
  assertTrustedIpcSender(event)
  const safeEmail = assertString(email, "email", 320)
  const safePassword = assertString(password, "password", 1_024)
  const safeTwoFactorCode = twoFactorCode === undefined ? undefined : assertString(twoFactorCode, "two-factor code", 64)

  try {
    const firstPass = interpretFirstPass(safeEmail, await requestLoginPass(safeEmail, safePassword), { twoFactorCodeProvided: Boolean(safeTwoFactorCode) })
    if (firstPass.status !== "complete-two-factor") return await settle(firstPass)

    return await settle(interpretSecondPass(safeEmail, await requestLoginPass(safeEmail, safePassword, safeTwoFactorCode, firstPass.preLoginToken)))
  } catch (error) {
    logMessage("error", "[back] [ipc] [accountHandlers.ts] [LOGIN] Login failed.")
    logMessage("debug", `[back] [ipc] [accountHandlers.ts] [LOGIN] ${getErrorMessage(error)}`)
    throw new Error("Login failed")
  }
})

ipcMain.handle(IPC_CHANNELS.ACCOUNT_MANAGER.REMOVE_ACCOUNT, async (event, accountId: unknown): Promise<boolean> => {
  assertTrustedIpcSender(event)
  return await removeAccountSecrets(assertString(accountId, "account id", 256))
})
