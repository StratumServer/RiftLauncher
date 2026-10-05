import type { AppUpdater } from "electron-updater"
import { setTimeout } from "node:timers"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { markUpdateAvailable, markUpdateDownloaded, resetUpdateDownload } from "@src/ipc/handlers/appUpdaterHandlers"
import { logMessage } from "@src/utils/logManager"

/** Sends one main-to-renderer message, or does nothing when there is no live window to send it to. */
export type SendToRenderer = (channel: string, payload?: unknown) => void

/**
 * The version the current offer is for, remembered from "update-available" so
 * every progress tick can name it. electron-updater's own progress event
 * carries bytes and a percentage but no version, and the renderer should not
 * have to reconstruct which offer a stream of percentages belongs to.
 */
let offeredVersion = ""

/** How long a launch gets to become interactive before the check goes anywhere near the network. */
const UPDATE_CHECK_DELAY_MS = 5_000

/**
 * Arms the one update check a launch makes.
 *
 * `readAllowPrerelease` is called when the check fires, not when it is armed, and that is the whole
 * point of it being a function. The answer comes from a setting the player can change while the
 * launcher is running, and reading it early would mean a change made in that window is silently
 * ignored with nothing on screen saying so. Resolving it is a config read and a string check, so
 * doing it per check costs nothing worth saving.
 *
 * Only which builds are offered moves here; allowDowngrade stays untouched, so this can never walk
 * an install backwards.
 *
 * Deferred so the initial window has had time to become interactive.
 *
 * checkForUpdates, not checkForUpdatesAndNotify: the "AndNotify" half only ever fires an OS
 * notification off the download promise the check returns, and with autoDownload off
 * (registerAutoUpdaterEvents) there is no such promise, so the two calls now do exactly the same
 * thing. Saying checkForUpdates keeps that honest, and leaves no second, OS-level announcement
 * racing the in-app one the renderer draws.
 *
 * The catch is not optional. Launching a packaged build with no network at all rejects this
 * promise, and an unhandled rejection in the main process is a crash report waiting to happen for
 * what is an entirely ordinary situation. electron-updater's own "error" event still fires, so the
 * renderer hears about it the usual way; this only keeps the rejection of that same failure from
 * going nowhere.
 *
 * The catch is also where a failed check is logged: once, as a warn line holding the first line of
 * the message and nothing after it. With the GitHub provider that first line is the reason, and
 * what follows is the whole releases feed (#650). It is a warning because a check that fails is no
 * fault of the launcher's. It lives here, and not in a listener on the updater's "error" event,
 * because a check that never went out (the beta setting could not be read) fails without the
 * updater having heard of it.
 *
 * `autoUpdater` is handed in rather than imported, here and in
 * registerAutoUpdaterEvents, because the module is loaded on demand now
 * (src/utils/autoUpdaterLoader.ts). Taking it as an argument is what keeps the
 * one load on the one path that decided an update is possible at all, and
 * leaves both functions drivable from a test without an import to intercept.
 */
export function scheduleUpdateCheck(autoUpdater: AppUpdater, readAllowPrerelease: () => Promise<boolean>, delayMs: number = UPDATE_CHECK_DELAY_MS): void {
  const timer = setTimeout(() => {
    void (async (): Promise<void> => {
      autoUpdater.allowPrerelease = await readAllowPrerelease()
      await checkWithoutErrorRecord(autoUpdater)
    })().catch((error) => {
      const reason = (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0] ?? ""
      logMessage("warn", `[back] [autoUpdaterEvents] [main/autoUpdaterEvents.ts] [scheduleUpdateCheck] Update check failed: ${reason}.`)
    })
  }, delayMs)
  timer.unref()
}

/**
 * Runs the check with electron-updater's own record of its failure switched off.
 *
 * The package reports a failed check by itself, before the promise rejects: its constructor listens
 * to its own "error" event and writes `Error: ${error.stack}` through its logger, at error level.
 * With the GitHub provider that message is a first line naming the reason followed by the whole
 * releases feed, so a check that failed, for want of a network or of a regular release to find, put
 * a page of XML in error.log at every launch (#650). scheduleUpdateCheck reports the same failure
 * once, in one line, which makes the package's line the duplicate.
 *
 * Only the error level of the logger in place is swapped out, and it goes back whatever the check
 * does. A download or an install that fails has no check around it, so the package's record of those
 * stays as it was. A launch makes one check, so two of these swaps never overlap. The swap reaches
 * the package because it looks its logger up when it writes the line instead of keeping a copy;
 * tests/main/updateCheckFailureLog.test.ts holds that against the real package.
 */
async function checkWithoutErrorRecord(autoUpdater: AppUpdater): Promise<void> {
  const logger = autoUpdater.logger
  autoUpdater.logger = {
    info: (message?: unknown): void => logger?.info(message),
    warn: (message?: unknown): void => logger?.warn(message),
    error: (): void => {},
    debug: (message: string): void => logger?.debug?.(message)
  }

  try {
    await autoUpdater.checkForUpdates()
  } finally {
    autoUpdater.logger = logger
  }
}

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
 *
 * autoInstallOnAppQuit is turned off for the same reason, one step later (#648):
 * the answer to "install it" is the player's too. electron-updater defaults it
 * to on, and with it on the first finished download hooks the app's quit event
 * and runs the installer silently the next time the launcher closes, whatever
 * the player did with the "ready" toast. Off, a finished download installs
 * through UPDATE_AND_RESTART and nowhere else, the "Restart and update" button
 * on that toast and on its Activity Center entry. A download left waiting is
 * not lost: electron-updater keeps it in its cache, the next launch offers the
 * update again, and accepting that offer finds the cached file and reports it
 * downloaded without fetching it a second time.
 */
export function registerAutoUpdaterEvents(autoUpdater: AppUpdater, send: SendToRenderer): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on("update-available", (info) => {
    offeredVersion = info?.version ?? ""
    markUpdateAvailable(offeredVersion, send)
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

  // electron-updater already logs this through autoUpdater.logger (a failed
  // check apart: scheduleUpdateCheck reports that one, once); forwarding
  // it exists so a download that dies halfway does not leave a progress bar
  // frozen at whatever percentage it reached. A failed check (no window of
  // consent open yet) forwards too, and lands on a task that is not there,
  // which the renderer's reducer treats as a no-op.
  //
  // The reset is what makes a second attempt possible without relaunching:
  // the re-entrancy guard would otherwise still think a download is in flight
  // and refuse the retry the renderer is about to offer. Doing it from the
  // event rather than relying on downloadUpdate's rejection covers the failures
  // electron-updater reports through the event alone.
  autoUpdater.on("error", () => {
    resetUpdateDownload()
    send(IPC_CHANNELS.APP_UPDATER.UPDATE_ERROR)
  })
}
