/**
 * Decides whether the auto-updater should run at all for this process.
 *
 * electron-updater can only apply what electron-builder publishes: Windows
 * installers, and on Linux the AppImage (it swaps the file the `APPIMAGE`
 * env var points at, which only AppImage runs set). A deb install has no
 * such variable, so starting the machinery there downloads an update the
 * host can never apply. Nothing is published for macOS at all.
 */

/** Why the updater stays off. */
export type CanAutoUpdateFailure = "updates-disabled" | "linux-not-appimage" | "unsupported-platform"

export type CanAutoUpdateResult = { ok: true } | { ok: false; reason: CanAutoUpdateFailure }

export interface CanAutoUpdateInput {
  platform: NodeJS.Platform
  env: { UPDATE?: string; APPIMAGE?: string }
}

function refuse(reason: CanAutoUpdateFailure): CanAutoUpdateResult {
  return { ok: false, reason }
}

/**
 * Says whether this run can check for, download and apply updates.
 *
 * @param input The process platform and the two env vars the decision reads.
 * @returns Ok, or the reason the updater must stay off.
 */
export function canAutoUpdate(input: CanAutoUpdateInput): CanAutoUpdateResult {
  const { platform, env } = input

  if (env.UPDATE === "false") return refuse("updates-disabled")
  if (platform === "win32") return { ok: true }
  if (platform === "linux") {
    if (env.APPIMAGE === undefined || env.APPIMAGE === "") return refuse("linux-not-appimage")
    return { ok: true }
  }

  return refuse("unsupported-platform")
}
