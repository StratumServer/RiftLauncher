import Logger from "electron-log"

import { redactSensitiveText } from "@domain/redaction"

/**
 * Re-exported, not redefined. The patterns moved to src/domain/redaction.ts so the session report
 * (#462) could reach them from pure code, and every caller that imported the redactor from here
 * still does, tests/log-provenance.test.ts and tests/ipc-validation.test.ts included.
 */
export { redactSensitiveText }

export function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Operation failed"
  return redactSensitiveText(error.message)
}

export function logMessage(mode: ErrorTypes, message: string): void {
  const safeMessage = redactSensitiveText(message)

  switch (mode) {
    case "error":
      Logger.error(safeMessage)
      break
    case "warn":
      Logger.warn(safeMessage)
      break
    case "info":
      Logger.info(safeMessage)
      break
    case "debug":
      Logger.debug(safeMessage)
      break
    case "verbose":
      Logger.verbose(safeMessage)
      break
    default:
      break
  }
}
