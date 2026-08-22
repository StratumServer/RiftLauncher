/**
 * Wraps the preload-bridge calls MainMenu's PlayHandler, its quick-backup button, and
 * GlobalActionsWrapper's "your close was prevented" notice need.
 *
 * Lives in its own feature rather than features/versions (which owns "is this game version
 * ready to run") or features/installations (which owns the backup itself): "launch the game, keep
 * the app open while it runs, tell the user why it couldn't close" is a distinct concern from
 * either one. It also keeps
 * every window.api touch out of src/renderer/src/components, where none is allowed.
 */

export function preventAppClose(action: "add" | "remove", id: string, desc: string): void {
  window.api.utils.setPreventAppClose(action, id, desc)
}

export function runGame(gameVersion: GameVersionType, installation: InstallationType): Promise<GameExecutionResult> {
  return window.api.gameManager.executeGame(gameVersion, installation)
}

export function checkInstallationPathExists(path: string): Promise<boolean> {
  return window.api.pathsManager.checkPathExists(path)
}

export function logLaunch(level: ErrorTypes, message: string): void {
  window.api.utils.logMessage(level, message)
}

export function onPreventedAppClose(callback: () => void): Unsubscribe {
  return window.api.utils.onPreventedAppClose(callback)
}
