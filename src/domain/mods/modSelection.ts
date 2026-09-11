import type { ModpackEntry } from "./importModpack"
import { installedCopiesOf } from "./installedFilters"

/**
 * How many Mods the browse page lets a player pick for one install run.
 *
 * A UX bound, not a technical one: the import pipeline takes 2000 entries. Each pick costs one ModDB
 * lookup and one sequential download in a table the player watches, so this keeps an accidental
 * Select visible on a grid scrolled to hundreds from turning into a run nobody meant.
 */
export const MAX_MOD_SELECTION = 100

/**
 * One Mod picked on the browse page, copied off its ModDB listing so a pick the current filter hides
 * still has everything the install table needs. Keyed by the listing id, the one identity a listing
 * has: two listings can share a name, and a fork can share the original's modid.
 */
export interface ModPick {
  listingId: number
  name: string
  modidstrs: readonly string[]
}

function isPicked(picks: readonly ModPick[], listingId: number): boolean {
  return picks.some((pick) => pick.listingId === listingId)
}

/** Unpicks a picked listing, or picks it while the selection is under the cap. */
export function togglePick(picks: readonly ModPick[], pick: ModPick): readonly ModPick[] {
  if (isPicked(picks, pick.listingId)) return picks.filter((picked) => picked.listingId !== pick.listingId)
  return picks.length < MAX_MOD_SELECTION ? [...picks, pick] : picks
}

/** Appends the listings not picked yet, in order, up to the cap. */
export function addPicks(picks: readonly ModPick[], candidates: readonly ModPick[]): readonly ModPick[] {
  const next = [...picks]
  for (const candidate of candidates) {
    if (next.length >= MAX_MOD_SELECTION) break
    if (!isPicked(next, candidate.listingId)) next.push(candidate)
  }
  return next
}

/**
 * Turns the picks into the entries the import planner reads, and counts the picks left out.
 *
 * A pick matching an installed copy (the grid's own Installed rule) takes that copy's modid, casing
 * and all: the planner matches modids exactly, and a modinfo.json may spell "BetterRuins" where the
 * listing says "betterruins", which would plan a second archive next to the first. A pick matching
 * several copies is marked so the planner skips it, as the card does: acting on one of them would be
 * picking a file for the player, chosen by the order the folder happens to list them in. Two picks landing
 * on one modid keep the first one picked, since a folder cannot hold two archives declaring one
 * modid and the table's rows are keyed by it.
 *
 * ponytail: only a listing's first modidstr keys a pick that is not installed, so two picks colliding
 * only through a secondary id are not collapsed; match on every modidstr if a listing ever needs it.
 */
export function modSelectionEntries(picks: readonly ModPick[], installed: readonly { modid: string }[]): { entries: ModpackEntry[]; leftOut: number } {
  const entries: ModpackEntry[] = []
  const seen = new Set<string>()

  for (const pick of picks) {
    const copies = installedCopiesOf(pick.modidstrs, installed)
    const modid = copies[0]?.modid ?? pick.modidstrs[0] ?? String(pick.listingId)
    if (seen.has(modid)) continue
    seen.add(modid)
    const entry: ModpackEntry = { modid, listingId: pick.listingId, name: pick.name }
    entries.push(copies.length > 1 ? { ...entry, severalCopies: true } : entry)
  }

  return { entries, leftOut: picks.length - entries.length }
}
