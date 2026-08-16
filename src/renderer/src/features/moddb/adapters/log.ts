/**
 * Routes a mods-feature log line through the preload bridge.
 *
 * See moddb.ts for why this lives outside features/mods: every mods hook that used to call
 * `window.api.utils.logMessage` directly now goes through here instead.
 */
export function logMods(level: ErrorTypes, message: string): void {
  window.api.utils.logMessage(level, message)
}
