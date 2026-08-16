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
