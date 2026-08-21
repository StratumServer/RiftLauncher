import { ipcMain } from "electron"
import { autoUpdater } from "electron-updater"

import { IPC_CHANNELS } from "../ipcChannels"
import { isTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { logMessage } from "@src/utils/logManager"

/**
 * Two one-way flags the renderer cannot set: only the updater's own events
 * flip them, through the marks below, and every renderer-initiated channel
 * here refuses to act until the matching one is set.
 *
 * `updateAvailable` is what makes DOWNLOAD_UPDATE a consent channel rather
 * than a "start downloading whatever you like" button (#184): the renderer
 * can only ever confirm the one update the main process already found and
 * offered, and only after it has been offered.
 */
let updateAvailable = false
let updateDownloaded = false

/**
 * Set once the accepted download is under way, so a second click on the same
 * notification (or anything else sending the channel twice) cannot start a
 * second download of the same artifact. Cleared again if the download fails,
 * which leaves the next offer able to proceed.
 */
let updateDownloadStarted = false

export function markUpdateAvailable(): void {
  updateAvailable = true
}

export function markUpdateDownloaded(): void {
  updateDownloaded = true
}

ipcMain.on(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, (event) => {
  if (!isTrustedIpcSender(event) || !updateAvailable || updateDownloadStarted) return
  updateDownloadStarted = true

  logMessage("info", "[back] [appUpdater] [ipc/handlers/appUpdaterHandlers.ts] [DOWNLOAD_UPDATE] Update accepted by the user. Downloading.")

  // electron-updater emits its own "error" event for a failed download, which
  // is what tells the renderer the task died; this catch only exists so the
  // rejection of the very same failure is not also an unhandled rejection.
  void autoUpdater.downloadUpdate().catch(() => {
    updateDownloadStarted = false
  })
})

ipcMain.on(IPC_CHANNELS.APP_UPDATER.UPDATE_AND_RESTART, (event) => {
  if (!isTrustedIpcSender(event) || !updateDownloaded) return
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch {
    updateDownloaded = false
  }
})
