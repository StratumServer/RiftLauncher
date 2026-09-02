import semver from "semver"

/**
 * Orders VS Version strings newest first, tolerating one semver cannot parse.
 *
 * A registered version is not always one semver can read. Detection now stores
 * only a parseable token, but the field is hand-editable, and configs written
 * before that fix still hold whatever a probed executable happened to print, so
 * a string like "Vintage Story 1.21.0" can be sitting in one right now.
 * `semver.rcompare` throws on that, and a throw inside a component's sort
 * callback takes the whole page down with it.
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
