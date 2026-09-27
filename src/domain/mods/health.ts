import semver from "semver"

import { evaluateModCompatibility, findModUpdate } from "./compatibility"

/**
 * What one Installation's Mods folder is wrong about, before the game is started.
 *
 * Every verdict here is a derivation of what the scan already holds: the archives' own metadata and
 * the ModDB detail the page fetched per Mod. Nothing is fetched, nothing is written, and the two
 * verdicts the launcher already has words for, `undeclared` and "there is an update", are taken
 * from compatibility.ts unchanged rather than re-derived, so this panel and the per-Mod detail
 * panel cannot end up disagreeing about the same Mod.
 *
 * The whole risk here is a false positive. A checklist that is wrong on a normal folder is worse
 * than no checklist, so every rule below refuses rather than guesses: a version neither side can
 * read skips the comparison, an unreadable archive is counted and left out, and the game's own
 * bundled mod ids are floors rather than missing downloads.
 */

/** One installed copy, as much of it as any rule here reads. */
export interface ModHealthCopy {
  modid: string
  version: string
  /** Full path of the archive, the only identity two copies of one mod id do not share. */
  path: string
  enabled: boolean
  /** Mod id to lowest acceptable version, straight out of modinfo.json. See src/domain/mods/modinfo.ts. */
  dependencies?: Readonly<Record<string, string>>
  /** The ModDB releases for this mod id, newest first, or absent when the ModDB did not answer for it. */
  releases?: readonly { modversion: string; tags: readonly string[] }[]
}

/** Which heading a finding belongs under, worst first. */
export type ModHealthSection = "blocking" | "duplicate" | "undeclared" | "update"

/** One thing wrong with one installed copy. `path` names the copy, `modid` is what it declares. */
export type ModHealthFinding = { section: ModHealthSection; path: string; modid: string } & (
  | { kind: "dependency-missing" | "dependency-disabled"; dependency: string; required?: string }
  | { kind: "dependency-outdated"; dependency: string; required: string; found: string }
  | { kind: "game-version-below"; required: string }
  /** `other` is the path of the copy declaring the same mod id, never a name: names live in the UI. */
  | { kind: "duplicate-modid"; other: string }
  | { kind: "undeclared" }
  | { kind: "update"; toVersion: string }
)

/**
 * Mod ids that ship inside Vintage Story, so a dependency on one is a floor against the game's own
 * version and never an archive to go and install.
 *
 * The issue names `game` alone. `survival` and `creative` are here because both are declared
 * constantly (the wiki's own example declares `survival`) and neither is a downloadable Mod, so
 * without them the check reports a missing dependency on nearly every Mod in a real folder. If
 * another bundled id turns up, this list is where it goes.
 */
export const GAME_BUNDLED_MODIDS: readonly string[] = ["game", "survival", "creative"]

/** How the sections are ordered on screen, so callers group without sorting. */
const SECTION_ORDER: readonly ModHealthSection[] = ["blocking", "duplicate", "undeclared", "update"]

/**
 * True for a bound that asks for the mod's presence and nothing about its version.
 *
 * The game reads `"*"` and the empty string the same way (Modding:Modinfo), and an author who means
 * "any version" writes one or the other with no pattern to it.
 */
function anyVersion(bound: string): boolean {
  return bound === "*" || bound === ""
}

/**
 * Whether `found` satisfies a declared floor of `required`, or undefined when neither can be judged.
 *
 * Undefined is the honest third answer and it is deliberately not "unsatisfied": Vintage Story
 * authors ship two-part ("1.0") and four-part ("1.2.3.4") versions regularly, semver reads neither,
 * and flagging those would blame a folder that is fine. It is the same refusal findModUpdate
 * already makes, and nothing here coerces a version into a shape it was not written in.
 */
function satisfies(found: string, required: string): boolean | undefined {
  if (anyVersion(required)) return true
  if (!semver.valid(found) || !semver.valid(required)) return undefined
  return semver.gte(found, required)
}

function lower(value: string): string {
  return value.toLowerCase()
}

/**
 * Everything wrong with one Mods folder, worst first.
 *
 * Only enabled copies are judged, for one reason that covers every section: a Mod the game does not
 * load cannot fail to load, cannot collide with anything, and is not part of what the player is
 * running. That also keeps the `X.zip` and `X.zip.disabled` pair the scan lists as two files (#292)
 * out of the duplicates.
 *
 * A suspended mod id drops every finding whose subject is that Mod, which is what holding a line
 * means: the player has said they know better about this Mod, and the check stops arguing about it.
 *
 * @param input.mods Every copy the scan read, disabled ones included.
 * @param input.gameVersion The Installation's game version, without a leading "v".
 * @param input.suspended Mod ids the player holds, matched without regard for case.
 */
export function checkModHealth(input: { mods: readonly ModHealthCopy[]; gameVersion: string; suspended?: readonly string[] }): ModHealthFinding[] {
  const held = new Set((input.suspended ?? []).map(lower))
  const subjects = input.mods.filter((mod) => mod.enabled && !held.has(lower(mod.modid)))

  const enabledByModid = new Map<string, ModHealthCopy[]>()
  const disabledIds = new Set<string>()
  for (const mod of input.mods) {
    if (!mod.enabled) {
      disabledIds.add(lower(mod.modid))
      continue
    }
    const copies = enabledByModid.get(lower(mod.modid))
    if (copies) copies.push(mod)
    else enabledByModid.set(lower(mod.modid), [mod])
  }

  const findings: ModHealthFinding[] = []

  for (const mod of subjects) {
    const where = { path: mod.path, modid: mod.modid }
    /** The bundled floors this Mod asks for and the Installation does not meet, highest last. */
    const gameFloors: string[] = []

    for (const [dependency, required] of Object.entries(mod.dependencies ?? {})) {
      if (GAME_BUNDLED_MODIDS.includes(lower(dependency))) {
        // The bundled ids are the mod's own floor against the game, so there is nothing to install
        // and nothing to turn on: either the Installation runs a new enough build or it does not.
        // A mod declaring `game` and `survival` at the same version is the common case and would
        // otherwise read as the same sentence twice, so only the highest floor is reported.
        if (satisfies(input.gameVersion, required) === false) gameFloors.push(required)
        continue
      }

      const installed = enabledByModid.get(lower(dependency)) ?? []
      // Undefined counts as met: an unreadable version on either side is a comparison this refuses
      // to make, not a Mod to report.
      if (installed.some((copy) => satisfies(copy.version, required) !== false)) continue

      const bound = anyVersion(required) ? {} : { required }
      const [older] = installed

      if (older) {
        findings.push({ section: "blocking", ...where, kind: "dependency-outdated", dependency, required, found: older.version })
      } else if (disabledIds.has(lower(dependency))) {
        // A finding and not a footnote: this is a real failed start, and the fix is one click.
        findings.push({ section: "blocking", ...where, kind: "dependency-disabled", dependency, ...bound })
      } else {
        findings.push({ section: "blocking", ...where, kind: "dependency-missing", dependency, ...bound })
      }
    }

    // Every floor here is readable on both sides, since that is what satisfies() answering false
    // means, so the highest of them is the one sentence that covers all of them.
    const [highestFloor] = gameFloors.sort(semver.rcompare)
    if (highestFloor) findings.push({ section: "blocking", ...where, kind: "game-version-below", required: highestFloor })

    // One line per copy naming the next one in the group, so a pair tells each about the other and
    // three copies still produce three lines rather than six. The fix is the row's own delete, which
    // is why nothing here guesses which copy should go.
    const sharing = enabledByModid.get(lower(mod.modid)) ?? []
    const next = sharing.length > 1 ? sharing[(sharing.indexOf(mod) + 1) % sharing.length] : undefined
    if (next) findings.push({ section: "duplicate", ...where, kind: "duplicate-modid", other: next.path })

    const releases = mod.releases
    if (!releases) continue

    const installedRelease = releases.find((release) => release.modversion === mod.version)
    if (installedRelease && evaluateModCompatibility(installedRelease.tags, input.gameVersion) === "undeclared") findings.push({ section: "undeclared", ...where, kind: "undeclared" })

    const update = findModUpdate(mod.version, releases, input.gameVersion)
    if (update.updatableTo) findings.push({ section: "update", ...where, kind: "update", toVersion: update.updatableTo })
  }

  // Sort is stable, so copies sharing a mod id keep the order the folder listed them in.
  return findings.sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || a.modid.localeCompare(b.modid))
}
