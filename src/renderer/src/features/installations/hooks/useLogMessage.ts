/** Writes one line to the host log, straight off the preload bridge. */
export function useLogMessage(): (level: ErrorTypes, message: string) => void {
  return (level, message) => window.api.utils.logMessage(level, message)
}
