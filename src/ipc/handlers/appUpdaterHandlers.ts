import { ipcMain } from "electron"
import { autoUpdater } from "electron-updater"

import { IPC_CHANNELS } from "../ipcChannels"
import { isTrustedIpcSender } from "@src/ipc/ipcSecurity"

let updateDownloaded = false

export function markUpdateDownloaded(): void {
  updateDownloaded = true
}

ipcMain.on(IPC_CHANNELS.APP_UPDATER.UPDATE_AND_RESTART, (event) => {
  if (!isTrustedIpcSender(event) || !updateDownloaded) return
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch {
    updateDownloaded = false
  }
})
