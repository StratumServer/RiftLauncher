/**
 * Who gets offered a beta build when the launcher checks for updates.
 *
 * Left alone, electron-updater answers this from the running version and nothing else: its
 * `allowPrerelease` getter is true exactly when the version the app is running carries prerelease
 * components. That is a reasonable guess and it is also unreachable, so somebody on a stable build
 * could never ask for betas and somebody who tried one beta was signed up for every beta after it.
 *
 * The stored choice is a tri-state on purpose. `null` means nobody has said, and the running
 * version keeps deciding, which is exactly what every existing install already does today. A `true`
 * or a `false` is a person answering, and it wins in both directions.
 */

/** Nobody has answered, so the running version decides. The value every config carries until the toggle is touched. */
export const DEFAULT_RECEIVE_BETA_UPDATES: boolean | null = null

/** Anything that is not an explicit yes or no, missing included, means nobody has answered. */
export function normalizeReceiveBetaUpdates(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : DEFAULT_RECEIVE_BETA_UPDATES
}

/**
 * Whether a version string names a prerelease.
 *
 * Semver puts the prerelease after the first `-` and the build metadata after the first `+`, and
 * build metadata is allowed a `-` of its own, so the metadata is dropped before looking. That is
 * the whole rule: `1.7.0-beta.3` is a prerelease, `1.7.0` and `1.7.0+build-2` are not.
 */
export function isPrereleaseVersion(version: string): boolean {
  return (version.split("+")[0] ?? "").includes("-")
}

/**
 * What to set `autoUpdater.allowPrerelease` to before a check.
 *
 * @param choice The stored answer, or null while there is none.
 * @param runningVersion The version this process is running, from `app.getVersion()`.
 */
export function resolveAllowPrerelease(choice: boolean | null, runningVersion: string): boolean {
  return choice ?? isPrereleaseVersion(runningVersion)
}
