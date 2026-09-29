/**
 * Client-side relevance ranking for a text search on the Mods page.
 *
 * The ModDB's `/api/mods` orders results by whatever `orderby` the request carries (follower
 * count by default), never by how well a Mod's name matches the search text. A popular Mod that
 * only mentions the word in its description then beats one named after it (issue #550). This
 * reorders the page the API already returned, stably, by name relevance: a name starting with
 * the text first, then a name containing it elsewhere, then everything else in the order the API
 * gave it.
 */
export function rankModsByTextRelevance<T extends { name: string }>(mods: T[], text: string): T[] {
  const needle = text.trim().toLowerCase()
  if (!needle) return mods

  function rank(mod: T): number {
    const name = mod.name.toLowerCase()
    if (name.startsWith(needle)) return 0
    if (name.includes(needle)) return 1
    return 2
  }

  // Array.prototype.sort is a stable sort (spec-guaranteed since ES2019), so mods tied on rank
  // keep the relative order the API returned them in without a manual tie-break.
  return [...mods].sort((a, b) => rank(a) - rank(b))
}
