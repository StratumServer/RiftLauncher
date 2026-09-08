/**
 * Picks which notification, if any, PlayHandler shows for one EXECUTE_GAME
 * verdict.
 *
 * Pulled out of MainMenu.tsx so the mapping can be pinned by a test without
 * mounting the component, which drags in the router and every context
 * MainMenu reads from.
 */

/**
 * The install guide to open for a missing .NET runtime, by host OS as Node's
 * `process.platform` spells it. Windows and Linux each have a page with a .NET
 * section; anything else, macOS and an OS not read yet included, gets the
 * index that links to all three rather than a page written for another OS.
 */
const INSTALL_GUIDE_URLS: Readonly<Record<string, string>> = {
  win32: "https://riftlauncher.stratumvs.dev/docs/get-started/installation/windows",
  linux: "https://riftlauncher.stratumvs.dev/docs/get-started/installation/linux"
}
const INSTALL_GUIDE_INDEX_URL = "https://riftlauncher.stratumvs.dev/docs/get-started/installation/"

/** The install guide for `os`, falling back to the index for an OS without a page of its own. */
export function installGuideUrl(os: string): string {
  return INSTALL_GUIDE_URLS[os] ?? INSTALL_GUIDE_INDEX_URL
}

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
 * `os` only matters to `missing-dotnet`, which links the guide for that OS.
 */
export function pickPlayOutcomeNotification(result: GameExecutionResult, os: string): PlayOutcomeNotification | null {
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
      return { key: "notifications.body.gameLaunchMissingDotnet", link: { url: installGuideUrl(os), labelKey: "notifications.actions.openInstallGuide" } }
    case "launch-failed":
      return { key: "notifications.body.errorExecutingGame" }
  }
}
