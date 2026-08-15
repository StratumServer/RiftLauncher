import Logger from "electron-log"

const sensitiveValuePattern = /(\b(?:password|pass|sessionkey|sessionsignature|mptoken|prelogintoken|token|signature|authorization|cookie|secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi
const sensitiveQueryPattern = /([?&](?:password|pass|sessionkey|sessionsignature|mptoken|prelogintoken|token|signature|authorization|cookie|secret)=)[^&#\s]+/gi
const absolutePathPattern = /(?:[A-Za-z]:[\\/]|\/(?:home|Users|mnt|tmp|var|opt|root)\/)[^\s\]]+/g

export function redactSensitiveText(message: string): string {
  return message.slice(0, 16_384).replace(sensitiveValuePattern, "$1[REDACTED]").replace(sensitiveQueryPattern, "$1[REDACTED]").replace(absolutePathPattern, "[PATH]")
}

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
