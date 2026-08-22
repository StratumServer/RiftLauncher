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
 * second download of the same artifact. Cleared again when the download fails,
 * which is what lets the user accept the retry the renderer offers them.
 */
let updateDownloadStarted = false

export function markUpdateAvailable(): void {
  updateAvailable = true
}

/**
 * Puts the consent machinery back where it was just before the user said yes,
 * so the same offer can be accepted a second time in the same session.
 *
 * Only the re-entrancy flag is cleared. `updateAvailable` deliberately stays
 * set: it records that the main process found and offered this version, and a
 * download failing does not un-find it. Clearing it would refuse the very retry
 * this exists to allow, and there is no second check in a session to set it
 * again.
 */
export function resetUpdateDownload(): void {
  updateDownloadStarted = false
}

export function markUpdateDownloaded(): void {
  updateDownloaded = true
}

ipcMain.on(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, (event) => {
  if (!isTrustedIpcSender(event) || !updateAvailable || updateDownloadStarted) return
  updateDownloadStarted = true

  logMessage("info", "[back] [appUpdater] [ipc/handlers/appUpdaterHandlers.ts] [DOWNLOAD_UPDATE] Update accepted by the user. Downloading.")

  // electron-updater emits its own "error" event for a failed download, which
  // is what tells the renderer the task died and clears the flag through
  // resetUpdateDownload; this catch only exists so the rejection of the very
  // same failure is not also an unhandled rejection, and clears the flag too
  // for the case of a rejection with no matching event.
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
