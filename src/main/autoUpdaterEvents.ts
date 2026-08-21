import { autoUpdater } from "electron-updater"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { markUpdateAvailable, markUpdateDownloaded } from "@src/ipc/handlers/appUpdaterHandlers"

/** Sends one main-to-renderer message, or does nothing when there is no live window to send it to. */
export type SendToRenderer = (channel: string, payload?: unknown) => void

/**
 * The version the current offer is for, remembered from "update-available" so
 * every progress tick can name it. electron-updater's own progress event
 * carries bytes and a percentage but no version, and the renderer should not
 * have to reconstruct which offer a stream of percentages belongs to.
 */
let offeredVersion = ""

/** Percent as a whole number between 0 and 100, the shape every other task in the app reports. */
export function toTaskProgress(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}

/**
 * Wires electron-updater's lifecycle onto the renderer, for the one case where
 * updates can actually be applied (main/index.ts only calls this inside the
 * canAutoUpdate-ok branch, so a platform that cannot install an update never
 * gets asked about one).
 *
 * autoDownload is turned off here rather than at module scope on purpose: it is
 * the single line that turns the whole thing from "download silently, tell the
 * user afterwards" into an offer the user answers (#184). Nothing downloads
 * until DOWNLOAD_UPDATE arrives from the renderer, and that channel refuses to
 * act until markUpdateAvailable has been called, which only happens below.
 */
export function registerAutoUpdaterEvents(send: SendToRenderer): void {
  autoUpdater.autoDownload = false

  autoUpdater.on("update-available", (info) => {
    offeredVersion = info?.version ?? ""
    markUpdateAvailable()
    send(IPC_CHANNELS.APP_UPDATER.UPDATE_AVAILABLE, { version: offeredVersion, releaseName: typeof info?.releaseName === "string" ? info.releaseName : undefined })
  })

  // Feeds the same progress bar every download in the app draws (#185). Sent
  // unconditionally: with autoDownload off, the only way bytes are moving at
  // all is that the user asked for them.
  autoUpdater.on("download-progress", (progress) => {
    send(IPC_CHANNELS.APP_UPDATER.UPDATE_DOWNLOAD_PROGRESS, { version: offeredVersion, progress: toTaskProgress(progress?.percent ?? 0) })
  })

  autoUpdater.on("update-downloaded", () => {
    markUpdateDownloaded()
    send(IPC_CHANNELS.APP_UPDATER.UPDATE_DOWNLOADED)
  })

  // electron-updater already logs this through autoUpdater.logger; forwarding
  // it exists so a download that dies halfway does not leave a progress bar
  // frozen at whatever percentage it reached. A failed check (no window of
  // consent open yet) forwards too, and lands on a task that is not there,
  // which the renderer's reducer treats as a no-op.
  autoUpdater.on("error", () => {
    send(IPC_CHANNELS.APP_UPDATER.UPDATE_ERROR)
  })
}
