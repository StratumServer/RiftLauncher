import semver from "semver"

/**
 * How a release's game-version tags relate to one game version.
 *
 * A release's compatibility tags are checkboxes an author ticks by hand on the ModDB at upload time,
 * pre-suggested from the mod's `modinfo.json` but never enforced against it. They go stale: an
 * author who moves on to a new project stops re-tagging old releases, so a release can run
 * perfectly on a game version its tags never mention. That is why `undeclared` below is named for
 * what is true (no tag claims this series) rather than for a conclusion the tags cannot support
 * ("incompatible"): the launcher does not know it will not work, only that nobody has said it will.
 */
export type ModCompatibilityVerdict =
  | "declared" // a tag matches the game version exactly: the author's own claim.
  | "same-minor" // no exact tag, but a tag shares the game version's Major.Minor series.
  | "undeclared" // no tag relates to this series at all.

/**
 * Judges a release's tags against one game version.
 *
 * @param tags Release tags as the API returns them, e.g. `release.tags`.
 * @param gameVersion Game version to judge against, without a leading "v", e.g. `"1.19.6"`.
 */
export function evaluateModCompatibility(tags: readonly string[], gameVersion: string): ModCompatibilityVerdict {
  if (tags.includes(gameVersion)) return "declared"

  const minorSeries = gameVersion.split(".").slice(0, 2).join(".")
  if (minorSeries.length > 0 && tags.some((tag) => tag.startsWith(minorSeries))) return "same-minor"

  return "undeclared"
}

/**
 * The newest release tagged for this game version's series, or undefined when none is.
 *
 * Releases come newest first, the order the ModDB serves them in, so the first release whose verdict
 * is not `undeclared` is the newest one an author has said something about for this series. There is
 * deliberately no fallback to an untagged release: callers that want one (the modpack import's last
 * resort) add it themselves, and callers acting from one click must not install something nobody
 * tagged for the build.
 */
export function newestCompatibleRelease<R extends { tags: readonly string[] }>(releases: readonly R[], gameVersion: string): R | undefined {
  return releases.find((release) => evaluateModCompatibility(release.tags, gameVersion) !== "undeclared")
}

/** What the ModDB offers past an installed version. */
export interface ModUpdate {
  /** The newest release above the installed one that is tagged for the game version's series. */
  updatableTo?: string
  /** The newest release above the installed one when it is tagged for no version of this series. */
  lastVersion?: string
}

/**
 * Decides whether an installed version has an update worth offering.
 *
 * Declared or same-minor both count as "worth offering": the tag compat check historically treated
 * "1.19.X" tags on a "1.19.6" install the same as an exact "1.19.6" tag, so only `undeclared` is
 * excluded. An untagged newer release is only recorded as `lastVersion`, which is what puts a Mod
 * under "Mods with incompatible updates". Versions semver cannot read are skipped, never guessed at.
 *
 * @param installedVersion The version the installed copy reports.
 * @param releases The ModDB releases, newest first.
 * @param gameVersion Game version to judge against, without a leading "v".
 */
export function findModUpdate(installedVersion: string, releases: readonly { modversion: string; tags: readonly string[] }[], gameVersion: string): ModUpdate {
  const update: ModUpdate = {}

  for (const release of releases) {
    if (!installedVersion || !release.modversion || !semver.valid(release.modversion) || !semver.valid(installedVersion)) continue

    const compatibleWithVersion = evaluateModCompatibility(release.tags, gameVersion) !== "undeclared"

    // -1 when the release is newer than the installed copy, 0 when equal, 1 when older.
    const newRelease = semver.compare(installedVersion, release.modversion)

    if (compatibleWithVersion && newRelease === -1) {
      update.updatableTo = release.modversion
      break
    } else if (!compatibleWithVersion && newRelease === -1 && !update.lastVersion) {
      update.lastVersion = release.modversion
    }
  }

  return update
}
