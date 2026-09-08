/**
 * Picks which notification, if any, PlayHandler shows for one EXECUTE_GAME
 * verdict.
 *
 * Pulled out of MainMenu.tsx so the mapping can be pinned by a test without
 * mounting the component, which drags in the router and every context
 * MainMenu reads from.
 */

/** The Linux dependency guide, the page that tells a player which .NET version their game version needs. */
export const LINUX_INSTALL_GUIDE_URL = "https://riftlauncher.stratumvs.dev/docs/get-started/installation/linux"

/** The i18n key to show, still unresolved: the caller owns the `t()` call and the notification type. */
export interface PlayOutcomeNotification {
  key: string
  /** An optional "read more" the caller turns into a notification action. Both halves are fixed here, never built from anything the game printed. */
  link?: { url: string; labelKey: string }
}

/**
 * `ok: true` shows nothing unless the game left with a non-zero exit code,
 * which is read as a crash worth telling the player about. `ok: false` always
 * shows something, keyed by why the game never ran; `launch-failed` reuses
 * the generic key that has always covered "the game could not be started".
 */
export function pickPlayOutcomeNotification(result: GameExecutionResult): PlayOutcomeNotification | null {
  if (result.ok) return result.exitCode !== null && result.exitCode !== 0 ? { key: "notifications.body.gameExitedWithErrors" } : null

  switch (result.reason) {
    case "unsupported-platform":
      return { key: "notifications.body.gameLaunchUnsupportedPlatform" }
    case "no-executable":
      return { key: "notifications.body.gameLaunchNoExecutable" }
    case "session-write-failed":
      return { key: "notifications.body.gameLaunchSessionWriteFailed" }
    case "invalid-request":
      return { key: "notifications.body.gameLaunchInvalidEnvironment" }
    case "missing-dotnet":
      return { key: "notifications.body.gameLaunchMissingDotnet", link: { url: LINUX_INSTALL_GUIDE_URL, labelKey: "notifications.actions.openLinuxInstallGuide" } }
    case "launch-failed":
      return { key: "notifications.body.errorExecutingGame" }
  }
}
