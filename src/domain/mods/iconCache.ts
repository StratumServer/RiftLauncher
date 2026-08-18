/**
 * Names the icon store writes today: the sha256 of the file's own bytes, lower case, with a `.png`
 * suffix. Anything else in the folder came from a build that named icons after a uuid, and no write
 * this launcher makes can produce one again.
 */
const CONTENT_ADDRESSED_NAME = /^[0-9a-f]{64}\.png$/

/**
 * How many bytes of mod icons the shared cache folder is allowed to keep.
 *
 * A real `modicon.png` runs tens of kilobytes, so this holds on the order of a thousand distinct
 * icons, well past the 2000 archives a single scan will even read. It is a judgement call rather
 * than a measurement, and it is one constant if it ever bites.
 */
export const MOD_ICON_CACHE_MAX_BYTES = 64 * 1024 * 1024

/** One file the host found in the cache folder. */
export interface CachedIcon {
  /** File name inside the cache folder, never a path. */
  name: string
  /** Size on disk. */
  bytes: number
  /** Last write or touch, in epoch milliseconds. */
  modifiedAt: number
}

/**
 * Which cached icons to delete, in two passes.
 *
 * Every name the current store could not have written goes first and unconditionally: those are the
 * uuid-named files an older build left behind, and nothing points at them. If the survivors still
 * do not fit `maxBytes`, the oldest go until they do.
 *
 * Age is the only signal available here on purpose. A scan sees one installation's mods, so no
 * caller ever holds the whole live set of a folder that every installation shares, and a sweep that
 * treats the icons it cannot see as dead deletes another installation's icons on every scan. The
 * store touches an icon's timestamp each time a scan points at it again, which makes "oldest" mean
 * "least recently used by any installation".
 *
 * @param entries Every file in the cache folder.
 * @param maxBytes Budget the survivors have to fit in.
 * @returns The names to remove, in deletion order.
 */
export function planIconCacheEviction(entries: readonly CachedIcon[], maxBytes: number = MOD_ICON_CACHE_MAX_BYTES): string[] {
  const evicted: string[] = []
  const survivors: CachedIcon[] = []

  for (const entry of entries) {
    if (CONTENT_ADDRESSED_NAME.test(entry.name)) survivors.push(entry)
    else evicted.push(entry.name)
  }

  let total = survivors.reduce((bytes, entry) => bytes + entry.bytes, 0)
  if (total <= maxBytes) return evicted

  for (const entry of [...survivors].sort((one, other) => one.modifiedAt - other.modifiedAt)) {
    if (total <= maxBytes) break
    evicted.push(entry.name)
    total -= entry.bytes
  }

  return evicted
}
