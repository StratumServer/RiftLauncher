import { ipcMain, dialog, app, shell } from "electron"
import { platform } from "node:os"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { isTrustedIpcSender, assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertAllowedBrowserUrl, assertSafeTaskId, assertString, isRecord } from "@src/ipc/validation"
import { logMessage } from "@src/utils/logManager"
import { setShouldPreventClose } from "@src/utils/shouldPreventClose"
import { registerUserSelectedPaths } from "@src/ipc/pathPolicy"

ipcMain.handle(IPC_CHANNELS.UTILS.GET_APP_VERSION, (event) => {
  assertTrustedIpcSender(event)
  return app.getVersion()
})

ipcMain.handle(IPC_CHANNELS.UTILS.GET_OS, (event) => {
  assertTrustedIpcSender(event)
  return platform()
})

ipcMain.on(IPC_CHANNELS.UTILS.LOG_MESSAGE, (event, mode: ErrorTypes, message: string): void => {
  if (!isTrustedIpcSender(event)) return
  if (!["error", "warn", "info", "debug", "verbose"].includes(mode)) return

  try {
    logMessage(mode, assertString(message, "log message", 16_384))
  } catch {
    logMessage("warn", "[back] [ipc] [ipc/handlers/utilsHandlers.ts] [LOG_MESSAGE] Rejected an invalid log message.")
  }
})

ipcMain.on(IPC_CHANNELS.UTILS.SET_PREVENT_APP_CLOSE, (event, action: "add" | "remove", id: string, desc: string) => {
  if (!isTrustedIpcSender(event)) return
  if (action !== "add" && action !== "remove") return

  try {
    setShouldPreventClose(action, assertSafeTaskId(id), assertString(desc, "task description", 256))
  } catch {
    logMessage("warn", "[back] [ipc] [ipc/handlers/utilsHandlers.ts] [SET_PREVENT_APP_CLOSE] Rejected invalid task state.")
  }
})

ipcMain.on(IPC_CHANNELS.UTILS.OPEN_ON_BROWSER, (event, url: string): void => {
  if (!isTrustedIpcSender(event)) return

  try {
    const safeUrl = assertAllowedBrowserUrl(url)
    logMessage("info", "[back] [ipc] [ipc/handlers/utilsHandlers.ts] [OPEN_ON_BROWSER] Opening an approved URL on the default browser.")
    void shell.openExternal(safeUrl.toString()).catch(() => {
      logMessage("warn", "[back] [ipc] [ipc/handlers/utilsHandlers.ts] [OPEN_ON_BROWSER] The default browser rejected the URL.")
    })
  } catch {
    logMessage("warn", "[back] [ipc] [ipc/handlers/utilsHandlers.ts] [OPEN_ON_BROWSER] Rejected an unsafe URL.")
  }
})

ipcMain.handle(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG, async (event, options?: { type?: "file" | "folder"; mode?: "single" | "multi"; extensions?: string[] }): Promise<string[]> => {
  assertTrustedIpcSender(event)
  logMessage("info", `[back] [ipc] [ipc/handlers/utilsHandlers.ts] [SELECT_FOLDER_DIALOG] Opening folder selection.`)

  if (options !== undefined) {
    if (!isRecord(options)) throw new TypeError("Invalid dialog options")
    if (options.type !== undefined && options.type !== "file" && options.type !== "folder") throw new TypeError("Invalid dialog type")
    if (options.mode !== undefined && options.mode !== "single" && options.mode !== "multi") throw new TypeError("Invalid dialog mode")
    if (
      options.extensions !== undefined &&
      (!Array.isArray(options.extensions) ||
        options.extensions.length > 16 ||
        options.extensions.some((extension) => typeof extension !== "string" || !/^[A-Za-z0-9][A-Za-z0-9+_-]{0,31}$/.test(extension)))
    ) {
      throw new TypeError("Invalid dialog extensions")
    }
  }

  const properties: ("openFile" | "openDirectory" | "multiSelections")[] = [options?.type === "file" ? "openFile" : "openDirectory"]

  if (options?.mode === "multi") properties.push("multiSelections")

  const result = await dialog.showOpenDialog({
    title: "Selecciona una carpeta",
    properties,
    filters: options?.extensions && [{ name: options.extensions.join(", "), extensions: options.extensions }]
  })

  if (result.canceled) {
    logMessage("warn", `[back] [ipc] [ipc/handlers/utilsHandlers.ts] [SELECT_FOLDER_DIALOG] Operation cancelled.`)
    return []
  }

  logMessage("info", `[back] [ipc] [ipc/handlers/utilsHandlers.ts] [SELECT_FOLDER_DIALOG] Selection completed with ${result.filePaths.length} path(s).`)
  registerUserSelectedPaths(result.filePaths)

  return result.filePaths
})
