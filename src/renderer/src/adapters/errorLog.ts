const LOG_TAG = "[front] [app] [adapters/errorLog.ts]"

/**
 * Writes a renderer exception to the log file through the preload bridge.
 *
 * Only the error and the stacks go in. `redactSensitiveText` (src/utils/logManager.ts) runs on
 * the main-process side of the bridge and scrubs tokens and absolute paths out of what lands
 * here, but it cannot un-log a value this function had no business reading in the first place,
 * so nothing else about the app state is collected: no route, no props, no config.
 *
 * The write is guarded because this is the last thing standing when something has already gone
 * wrong. If the bridge itself is missing (a preload that failed to load), throwing from here
 * would be reported as another uncaught error, which the global listener below would hand
 * straight back to this function.
 */
export function logRenderError(source: string, error: unknown, componentStack?: string | null): void {
  const name = error instanceof Error ? error.name : "NonError"
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined

  const lines = [`${LOG_TAG} [${source}] ${name}: ${message}`]
  if (stack) lines.push(stack)
  if (componentStack) lines.push(`Component stack:${componentStack}`)

  try {
    window.api.utils.logMessage("error", lines.join("\n"))
  } catch {
    // Nothing left to report it to.
  }
}

/**
 * Catches what an error boundary cannot: throws from event handlers, timers and async code, and
 * rejected promises nobody awaited. React only sees exceptions raised during render, commit and
 * lifecycle, so without these two listeners a player's error.log stays empty for a whole class of
 * failure. React also rethrows a render error no boundary caught, which reaches the "error"
 * listener, so a throw in the shell itself is logged too.
 *
 * Both handlers log and return. They do not preventDefault and they do not rethrow: swallowing an
 * error here would hide it from the devtools console during development for no gain in the field.
 *
 * Returns a disposer. The app never calls it (these live as long as the window does), tests do.
 */
export function installGlobalErrorLogging(): () => void {
  const onError = (event: ErrorEvent): void => logRenderError("window.error", event.error ?? event.message)
  const onRejection = (event: PromiseRejectionEvent): void => logRenderError("window.unhandledrejection", event.reason)

  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onRejection)

  return (): void => {
    window.removeEventListener("error", onError)
    window.removeEventListener("unhandledrejection", onRejection)
  }
}
