/**
 * Maps SAVE_CONFIG's internal refusals onto the {@link SaveConfigResult} wire
 * type.
 *
 * Pulled out of configHandlers.ts for the same reason as
 * gameExecutionOutcome.ts: that file calls `ipcMain.handle` at module load,
 * which needs a running Electron main process and so cannot be imported by a
 * unit test. Nothing here touches Electron or Node, so a test can pin each
 * mapping directly.
 */

/** The payload was not even a record: see {@link SaveConfigFailureReason}. */
export function invalidPayloadResult(): SaveConfigResult {
  return { ok: false, reason: "invalid-payload" }
}

/** `assertConfigPathsAuthorized` refused the incoming config's paths. */
export function unauthorizedPathResult(): SaveConfigResult {
  return { ok: false, reason: "unauthorized-path" }
}

/** Carries `saveConfig`'s own boolean verdict onto the wire, naming a `false` as `write-failed`. */
export function saveOutcomeToResult(saved: boolean): SaveConfigResult {
  return saved ? { ok: true } : { ok: false, reason: "write-failed" }
}
