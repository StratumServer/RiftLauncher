import { evaluateModCompatibility } from "./compatibility"
import { compareVersions } from "../versionNumbers"

/**
 * What the Manage Mods filter bar is set to. An empty string and an empty array both mean "not
 * filtering on this axis", which is what the clear button puts back.
 *
 * Only `author` reads the local `modinfo.json`. `tags` and `gameVersion` both read `_mod`, the ModDB
 * detail lookup, so a mod the ModDB has no entry for matches neither of them. The page keeps those
 * two controls off screen while their option lists are empty, so a run with no network offers no
 * filter it cannot honour rather than quietly hiding every mod.
 */
export interface InstalledModFilters {
  /** One author name. A mod matches when any of its credited authors equals it, ignoring case. */
  author: string
  /** ModDB category tags. A mod matches when it carries every one of them, not just one. */
  tags: readonly string[]
  /** One game version. A mod matches when any of its releases declares support for its series. */
  gameVersion: string
}

export const NO_INSTALLED_MOD_FILTERS: InstalledModFilters = { author: "", tags: [], gameVersion: "" }

/** The shape a ModDB game-version release tag has: a dotted number, never a leading "v". */
const GAME_VERSION_TAG = /^\d+(\.\d+)+/

/**
 * Deduplicates ignoring case, keeping the first spelling seen.
 *
 * The matchers below fold case, so two mods crediting "Ann" and "ann" are one author to a player and
 * belong on one row of the dropdown. Folding only at match time would offer both spellings as
 * separate options that select the same mods.
 */
function uniqueIgnoringCase(values: readonly string[]): string[] {
  const seen = new Map<string, string>()
  for (const value of values) {
    const key = value.toLowerCase()
    if (!seen.has(key)) seen.set(key, value)
  }
  return Array.from(seen.values())
}

/** Every author across the scan, A to Z. Read from the local modinfo, so this axis needs no network. */
export function installedModAuthors(mods: readonly InstalledModType[]): string[] {
  return uniqueIgnoringCase(mods.flatMap((mod) => mod.authors ?? [])).sort((a, b) => a.localeCompare(b))
}

/**
 * Every ModDB category tag across the scan, A to Z.
 *
 * `_mod` is the ModDB detail lookup, not the archive. `modinfo.json` carries no tags at all, as
 * modinfo.ts shows, so this list is empty for a folder the ModDB cannot answer for.
 */
export function installedModTags(mods: readonly InstalledModType[]): string[] {
  return uniqueIgnoringCase(mods.flatMap((mod) => mod._mod?.tags ?? [])).sort((a, b) => a.localeCompare(b))
}

/**
 * Every game version the installed mods' releases declare support for, newest first.
 *
 * These are `release.tags`, the compatibility checkboxes an author ticks on the ModDB. They are not
 * `release.modversion`, which is the mod's own release number, and they are not `_mod.tags`, which
 * are the category tags the other dropdown offers.
 */
export function installedModGameVersions(mods: readonly InstalledModType[]): string[] {
  const tags = mods.flatMap((mod) => (mod._mod?.releases ?? []).flatMap((release) => release.tags ?? []))
  return Array.from(new Set(tags.filter((tag) => GAME_VERSION_TAG.test(tag)))).sort((a, b) => compareVersions(b, a))
}

/** Ignores case, and counts every credited author rather than only the first one. */
function matchesAuthor(mod: InstalledModType, author: string): boolean {
  if (author === "") return true
  const wanted = author.toLowerCase()
  return (mod.authors ?? []).some((name) => name.toLowerCase() === wanted)
}

/** Every selected tag has to be present, so picking a second tag narrows the list rather than widening it. */
function matchesTags(mod: InstalledModType, tags: readonly string[]): boolean {
  if (tags.length < 1) return true
  const modTags = (mod._mod?.tags ?? []).map((tag) => tag.toLowerCase())
  return tags.every((tag) => modTags.includes(tag.toLowerCase()))
}

/**
 * True when any release declares the selected game version's series.
 *
 * `!== "undeclared"` rather than an exact tag match, so a release tagged "1.20.4" still answers a
 * search for "1.20.0". useGetCompleteInstalledMods draws this page's updatable and incompatible
 * split on this same line, and a filter drawing it anywhere else would contradict the sections
 * sitting under it.
 */
function matchesGameVersion(mod: InstalledModType, gameVersion: string): boolean {
  if (gameVersion === "") return true
  return (mod._mod?.releases ?? []).some((release) => evaluateModCompatibility(release.tags ?? [], gameVersion) !== "undeclared")
}

/** All three axes at once. A mod clears every one of them, so each pick narrows what is left. */
export function matchesInstalledModFilters(mod: InstalledModType, filters: InstalledModFilters): boolean {
  return matchesAuthor(mod, filters.author) && matchesTags(mod, filters.tags) && matchesGameVersion(mod, filters.gameVersion)
}

export function filterInstalledMods(mods: readonly InstalledModType[], filters: InstalledModFilters): InstalledModType[] {
  return mods.filter((mod) => matchesInstalledModFilters(mod, filters))
}

/** True when any axis is set. The empty state and the clear button both key off this. */
export function hasActiveInstalledModFilters(filters: InstalledModFilters): boolean {
  return filters.author !== "" || filters.tags.length > 0 || filters.gameVersion !== ""
}
