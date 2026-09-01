import semver from "semver"

/**
 * Orders VS Version strings newest first, tolerating one semver cannot parse.
 *
 * A registered version is whatever the game printed for `-v`: detect.ts trims
 * that stdout and stores it as-is, so a modded build, a pre-release or a probe
 * that answered something unexpected can leave a string like
 * "Vintage Story 1.21.0" in the config. `semver.rcompare` throws on that, and a
 * throw inside a component's sort callback takes the whole page down with it.
 *
 * Valid versions order among themselves exactly as they did. Anything
 * unparseable sorts after them, alphabetically, so the order stays the same on
 * every render.
 */
export function compareGameVersionsDesc(a: string, b: string): number {
  const aValid = semver.valid(a)
  const bValid = semver.valid(b)
  if (aValid && bValid) return semver.rcompare(a, b)
  if (aValid) return -1
  if (bValid) return 1
  return a.localeCompare(b)
}
