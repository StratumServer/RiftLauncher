import { ipcMain } from "electron"

import { interpretFirstPass, interpretSecondPass } from "@domain/account/login"
import type { LoginVerdict } from "@domain/account/login"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { requestBoundedText } from "@src/ipc/network"
import { assertString, MAX_LOGIN_RESPONSE_BYTES } from "@src/ipc/validation"
import { clearAccountSecrets, saveAccountSecrets } from "@src/ipc/accountStore"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

const LOGIN_URL = new URL("https://auth3.vintagestory.at/v2/gamelogin")

type AccountLoginResult = { status: "success"; account: AccountPublicType } | { status: "invalid-credentials" | "requires-two-factor" | "wrong-two-factor"; account?: undefined }

/**
 * Sends one login pass and hands back the raw body.
 *
 * Reading the body is `@domain/account/login`'s job, so this function has no
 * opinion about what came back and cannot decide to ask again. The URL is
 * allow-listed in `src/ipc/validation.ts` and the response is size-capped, both
 * unchanged from before the interpretation moved out.
 *
 * The password is a parameter and nothing else: it is never held in a field,
 * never logged, and never survives the call.
 */
async function requestLoginPass(email: string, password: string, twoFactorCode?: string, preLoginToken?: string): Promise<string> {
  const body = new URLSearchParams({
    email,
    password,
    totpcode: twoFactorCode ?? "",
    prelogintoken: preLoginToken ?? ""
  })

  return await requestBoundedText(LOGIN_URL, { method: "POST", body: body.toString(), maxBytes: MAX_LOGIN_RESPONSE_BYTES })
}

/**
 * Turns a domain verdict into the answer the renderer expects, storing the
 * session on the way through when there is one.
 *
 * The secrets go straight from the verdict into the encrypted store and stop
 * there. Only the public half rides back over IPC.
 */
async function settle(verdict: LoginVerdict): Promise<AccountLoginResult> {
  switch (verdict.status) {
    case "success":
      await saveAccountSecrets(verdict.credentials.secrets)
      return { status: "success", account: verdict.credentials.publicAccount }
    case "needs-two-factor":
      return { status: "requires-two-factor" }
    case "two-factor-rejected":
      return { status: "wrong-two-factor" }
    case "bad-credentials":
      return { status: "invalid-credentials" }
    case "unreadable-response":
      throw new Error("Login response could not be read")
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

ipcMain.handle(IPC_CHANNELS.ACCOUNT_MANAGER.LOGOUT, async (event): Promise<boolean> => {
  assertTrustedIpcSender(event)
  return await clearAccountSecrets()
})
