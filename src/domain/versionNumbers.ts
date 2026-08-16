/**
 * Ordering for the dotted version strings the launcher deals in.
 *
 * Both the game catalog and the ModDB publish versions as plain dotted numbers with an occasional
 * pre-release suffix (`1.20.0-rc.1`). The suffix is dropped rather than ranked: nothing in the
 * launcher has ever had to decide whether `rc.2` outranks `rc.1`, and guessing an order for it would
 * be a rule nobody asked for.
 */

/**
 * Compares two dotted version strings numerically.
 *
 * @param a Left version, without a leading "v".
 * @param b Right version, without a leading "v".
 * @returns Negative when `a` sorts before `b`, positive when it sorts after, zero when they tie.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => version.replace(/-.*$/, "").split(".").map(Number)

  const left = parts(a)
  const right = parts(b)

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }

  return 0
}
