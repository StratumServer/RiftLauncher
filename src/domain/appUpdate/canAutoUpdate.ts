/**
 * Decides whether the auto-updater should run at all for this process.
 *
 * electron-updater can only apply what electron-builder publishes: Windows
 * installers, the AppImage (it swaps the file the `APPIMAGE` env var points
 * at, which only AppImage runs set), and a deb install, which electron-updater's
 * own DebUpdater applies through dpkg once it reads the `package-type` marker
 * electron-builder writes next to the packaged app. Flatpak updates through its
 * own repo rather than electron-updater, so a Linux run with neither marker
 * stays refused. Nothing is published for macOS at all.
 */

/** Why the updater stays off. */
export type CanAutoUpdateFailure = "updates-disabled" | "linux-unsupported-package" | "unsupported-platform"

export type CanAutoUpdateResult = { ok: true } | { ok: false; reason: CanAutoUpdateFailure }

export interface CanAutoUpdateInput {
  platform: NodeJS.Platform
  env: { UPDATE?: string; APPIMAGE?: string }
  /** Content of electron-builder's `package-type` marker file, when the host found and read one. */
  linuxPackageType?: string
}

function refuse(reason: CanAutoUpdateFailure): CanAutoUpdateResult {
  return { ok: false, reason }
}

/**
 * Says whether this run can check for, download and apply updates.
 *
 * @param input The process platform, the two env vars, and the deb marker the decision reads.
 * @returns Ok, or the reason the updater must stay off.
 */
export function canAutoUpdate(input: CanAutoUpdateInput): CanAutoUpdateResult {
  const { platform, env, linuxPackageType } = input

  if (env.UPDATE === "false") return refuse("updates-disabled")
  if (platform === "win32") return { ok: true }
  if (platform === "linux") {
    if (env.APPIMAGE !== undefined && env.APPIMAGE !== "") return { ok: true }
    if (linuxPackageType === "deb") return { ok: true }
    return refuse("linux-unsupported-package")
  }

  return refuse("unsupported-platform")
}
