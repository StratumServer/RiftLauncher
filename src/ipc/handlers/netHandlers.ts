import { ipcMain } from "electron"

import { IPC_CHANNELS } from "../ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { requestBoundedText } from "@src/ipc/network"
import { assertAllowedApiUrl } from "@src/ipc/validation"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

ipcMain.handle(IPC_CHANNELS.NET_MANAGER.QUERY_URL, async (event, url: unknown): Promise<string> => {
  assertTrustedIpcSender(event)

  try {
    const safeUrl = assertAllowedApiUrl(url)
    return await requestBoundedText(safeUrl)
  } catch (err) {
    logMessage("error", "[back] [ipc] [ipc/handlers/netHandlers.ts] [QUERY_URL] Network request failed.")
    logMessage("debug", `[back] [ipc] [ipc/handlers/netHandlers.ts] [QUERY_URL] ${getErrorMessage(err)}`)
    throw err
  }
})
