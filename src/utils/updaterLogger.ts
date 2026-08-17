import type { Logger } from "electron-updater"

import { logMessage } from "./logManager"

/**
 * electron-builder's own documentation for auto-update diagnosability is
 * `autoUpdater.logger = require("electron-log")`, not a hand-written
 * listener per event. This app cannot hand electron-updater the raw
 * electron-log instance though: every other log line goes through
 * `logMessage`, which redacts tokens, credentials and absolute paths before
 * it reaches disk, and update errors can carry feed URLs and filesystem
 * paths. Routing each level through `logMessage` keeps that redaction while
 * still giving the updater's whole lifecycle a place to log to.
 */
export function createUpdaterLogger(log: (mode: ErrorTypes, message: string) => void = logMessage): Logger {
  const line = (message: unknown): string => `[back] [index] [utils/updaterLogger.ts] [autoUpdater] ${String(message)}`
  return {
    info: (message?: unknown) => log("info", line(message)),
    warn: (message?: unknown) => log("warn", line(message)),
    error: (message?: unknown) => log("error", line(message)),
    debug: (message?: unknown) => log("debug", line(message))
  }
}
