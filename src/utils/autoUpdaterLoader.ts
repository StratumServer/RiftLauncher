import type { AppUpdater } from "electron-updater"

import { createUpdaterLogger } from "@src/utils/updaterLogger"

/**
 * The one load of electron-updater this launch has asked for, or nothing when
 * it has not asked yet.
 *
 * The promise is what is remembered, not the module it resolves to, so two
 * callers racing the first load share one import. electron-updater's export is
 * a singleton whose listeners and `autoDownload` flag are configured exactly
 * once (registerAutoUpdaterEvents), and a second import resolving separately
 * would mean a second set of both.
 */
let loading: Promise<AppUpdater> | undefined

/**
 * Loads electron-updater, on the launches that turn out to need it.
 *
 * It used to be a top-level import in main/index.ts. Measured in the packaged
 * app by timing each top-level require, that import alone cost 88.9 ms of the
 * main module's 163.8 ms, more than every other dependency put together, and it
 * pulls 159 modules of its own. Every launch paid it, including the Linux
 * deb/rpm/pacman builds where the very next line logged is
 * "Auto-update disabled: linux-unsupported-package", and including every launch
 * of every platform where the player never accepts an update.
 *
 * The logger is attached here rather than left to the caller so the redaction
 * cannot be missed. electron-updater logs feed URLs and cache paths, and
 * createUpdaterLogger is what routes those through logMessage's redaction
 * before they reach disk; binding it to the load itself leaves no window in
 * which the module exists carrying its own default logger. The ordering that
 * mattered when this lived in main/index.ts still holds for free: every caller
 * reaches this well after `Logger.transports.file.resolvePathFn` is in place,
 * so nothing is written before the app's Logs directory is decided.
 */
export function loadAutoUpdater(): Promise<AppUpdater> {
  loading ??= import("electron-updater").then(({ autoUpdater }) => {
    autoUpdater.logger = createUpdaterLogger()
    return autoUpdater
  })

  return loading
}
