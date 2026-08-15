import { ipcMain } from "electron"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { requestBoundedText } from "@src/ipc/network"
import { assertString, isRecord, MAX_LOGIN_RESPONSE_BYTES } from "@src/ipc/validation"
import { clearAccountSecrets, saveAccountSecrets } from "@src/ipc/accountStore"
import { parseLoginAccount } from "@src/ipc/accountTypes"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

const LOGIN_URL = new URL("https://auth3.vintagestory.at/v2/gamelogin")

type AccountLoginResult = { status: "success"; account: AccountPublicType } | { status: "invalid-credentials" | "requires-two-factor" | "wrong-two-factor"; account?: undefined }

function isInvalidResponse(response: Record<string, unknown>): boolean {
  return response.valid === 0 || response.valid === "0" || response.valid === false
}

async function requestLogin(email: string, password: string, twoFactorCode?: string, preLoginToken?: string): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    email,
    password,
    totpcode: twoFactorCode ?? "",
    prelogintoken: preLoginToken ?? ""
  })
  const responseText = await requestBoundedText(LOGIN_URL, { method: "POST", body: body.toString(), maxBytes: MAX_LOGIN_RESPONSE_BYTES })
  const response: unknown = JSON.parse(responseText)
  if (!isRecord(response)) throw new Error("Login response was not an object")
  return response
}

ipcMain.handle(IPC_CHANNELS.ACCOUNT_MANAGER.LOGIN, async (event, email: unknown, password: unknown, twoFactorCode: unknown): Promise<AccountLoginResult> => {
  assertTrustedIpcSender(event)
  const safeEmail = assertString(email, "email", 320)
  const safePassword = assertString(password, "password", 1_024)
  const safeTwoFactorCode = twoFactorCode === undefined ? undefined : assertString(twoFactorCode, "two-factor code", 64)

  try {
    const preLogin = await requestLogin(safeEmail, safePassword)
    if (isInvalidResponse(preLogin)) {
      const reason = typeof preLogin.reason === "string" ? preLogin.reason : ""
      if (reason === "requiretotpcode") {
        const preLoginToken = typeof preLogin.prelogintoken === "string" ? preLogin.prelogintoken : undefined
        if (!safeTwoFactorCode) return { status: "requires-two-factor" }

        const fullLogin = await requestLogin(safeEmail, safePassword, safeTwoFactorCode, preLoginToken)
        if (isInvalidResponse(fullLogin)) {
          return { status: fullLogin.reason === "wrongtotpcode" ? "wrong-two-factor" : "invalid-credentials" }
        }

        const account = parseLoginAccount(safeEmail, fullLogin)
        await saveAccountSecrets(account.secrets)
        return { status: "success", account: account.publicAccount }
      }

      return { status: "invalid-credentials" }
    }

    const account = parseLoginAccount(safeEmail, preLogin)
    await saveAccountSecrets(account.secrets)
    return { status: "success", account: account.publicAccount }
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
