/**
 * Reading a release's game-version tags as a short list instead of every tag it carries.
 *
 * A release tagged for a whole game series lists every version of it: the reported case named about
 * thirty, from 1.22.0-pre.1 to 1.22.7, and the row grew taller than the window. Sorting those tags
 * and printing "first to last" would be shorter and wrong: the tags are checkboxes an author ticks
 * one by one, so a release can carry 1.22.0 and 1.22.7 while skipping everything between, and a
 * range written from its ends alone would claim support nobody declared.
 *
 * The ModDB's own `/gameversions` list is what makes the shorter form honest. It is the full,
 * ordered set of versions the tags are picked from, so a run collapses only when the tags cover
 * every catalog entry between its ends, and a version the release skipped splits the run in two.
 * With no catalog to check against, every tag stands on its own and the cell reads as it always has.
 */

/** One entry of the summary: a single version, or a run printed from one end to the other. */
export interface GameVersionRange {
  /** The older end of a run, or the only version this entry names. */
  from: string
  /** The newer end, set only on a run that was collapsed. */
  to?: string
}

/**
 * How many versions a run needs before collapsing it saves anything.
 *
 * Two versions written out are as short as the range that would replace them and say more, so only
 * three or more collapse.
 */
const SHORTEST_COLLAPSIBLE_RUN = 3

/**
 * The number a pre-release belongs to: both `1.22.0-pre.1` and `1.22.0-rc.10` are part of `1.22.0`.
 *
 * Read from the hyphen rather than from a list of known suffixes, so a series the ModDB spells some
 * other way (`-dev.2`, on every 1.4 and 1.5 entry of the live catalog) folds the same.
 */
function releaseNumber(tag: string): string {
  const suffix = tag.indexOf("-")
  return suffix === -1 ? tag : tag.slice(0, suffix)
}

/**
 * Summarises the game versions one release declares.
 *
 * @param tags The release's tags, in whatever order the ModDB returned them.
 * @param catalog Every game version the ModDB knows, newest first, as `useGameVersionsLookup`
 *   returns it. Empty when the lookup has not landed or failed, which falls back to one entry per
 *   tag: without the catalog nothing says which versions sit between two tags. The order is the
 *   caller's to keep: coverage is read off the catalog's own sequence, never off the numbers.
 * @returns The summary, oldest first, with any tag the catalog does not know trailing the rest.
 *   Nothing places such a tag in the sequence, so it goes after everything that was placed.
 */
export function summarizeGameVersionTags(tags: readonly string[], catalog: readonly string[]): GameVersionRange[] {
  if (catalog.length === 0) return tags.map((tag) => ({ from: tag }))

  const tagged = new Set(tags)
  const ranges: GameVersionRange[] = []
  let run: { from: string; to: string; size: number } | null = null

  function closeRun(): void {
    const current = run
    run = null

    if (current === null) return

    if (current.size >= SHORTEST_COLLAPSIBLE_RUN) {
      ranges.push({ from: current.from, to: current.to })
      return
    }

    ranges.push({ from: current.from })
    if (current.size > 1) ranges.push({ from: current.to })
  }

  // Oldest first, against a catalog handed over newest first: a collapsed run then reads
  // "1.22.0 to 1.22.7" and the whole cell climbs in the one direction.
  for (const version of [...catalog].reverse()) {
    // A version the release skipped ends the run. The two sides stay separate entries, which is
    // what keeps the summary from claiming the version in the gap.
    if (!tagged.has(version)) {
      closeRun()
      continue
    }

    // A tagged pre-release whose own number the release carries too stays inside the run without
    // being printed: 1.22.0-pre.1 through 1.22.0 is one thing to a player, and that thing is 1.22.0.
    if (releaseNumber(version) !== version && tagged.has(releaseNumber(version))) continue

    run = run === null ? { from: version, to: version, size: 1 } : { from: run.from, to: version, size: run.size + 1 }
  }
  closeRun()

  // A tag the catalog has never heard of cannot be placed between two versions, so it is printed as
  // it came, after everything that could be placed. The ModDB keeps old tags long after it stops
  // offering them, and mod authors mistype. Walking the tag set rather than the tags is what keeps
  // a repeat to one entry, which is what the catalog walk above already does with the tags it knows.
  const known = new Set(catalog)
  for (const tag of tagged) if (!known.has(tag)) ranges.push({ from: tag })

  return ranges
}
