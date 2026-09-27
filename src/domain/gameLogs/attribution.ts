/**
 * Which Mod an error belongs to, and how confidently.
 *
 * Best effort, and the report says so: the signal that named each group is shown, because a wrongly
 * blamed Mod is a mod author's bad afternoon. The rules are ordered by how much they are actually
 * reading rather than guessing.
 */

import { type LogEntry } from "@domain/gameLogs/lines"

/** How a group got its name. Shown to the reader, never inferred further. */
export type AttributionSignal = "modid-prefix" | "assembly" | "crash-file"

export interface ModGroup {
  modid: string
  signal: AttributionSignal
  errors: number
  warnings: number
  /** The lines kept for this Mod, bounded by {@link MAX_ENTRIES_PER_GROUP}. */
  entries: LogEntry[]
}

export interface AttributionResult {
  groups: ModGroup[]
  /** Errors and warnings no rule could name a Mod for. An honest bucket, not a guess. */
  unattributed: LogEntry[]
}

/** Ceilings on the report, so a session that logged thousands of errors still crosses IPC small. */
export const MAX_MOD_GROUPS = 40
export const MAX_ENTRIES_PER_GROUP = 12
/** The same for the unattributed bucket, which one broken Mod can fill on its own. */
export const MAX_UNATTRIBUTED_ENTRIES = 12

const MODID_PREFIX = /^\[([a-z0-9_.-]{1,64})\]/
const MOD_PHASE = /Failed to run mod phase (\w+) for mod ([\w.]+)/

function isReportable(entry: LogEntry): boolean {
  const severity = entry.severity.toLowerCase()
  return severity === "error" || severity === "warning"
}

/**
 * The installed modid an assembly or Harmony id points at, or undefined.
 *
 * `AncientTools.Utility.RegisterConfig` and `Egocarib.AutoMapMarkers.Patches` both carry the Mod in
 * their leading segment, matched case-insensitively against what is installed. This is a heuristic
 * and can name the wrong Mod, which is why every caller shows the signal and why a Harmony match
 * never opens a group of its own.
 */
export function modidForAssembly(assembly: string, installedModids: readonly string[]): string | undefined {
  const leading = (assembly.split(".")[0] ?? "").toLowerCase()
  if (leading.length === 0) return undefined
  return installedModids.find((modid) => modid.toLowerCase() === leading)
}

export function attributeEntries(entries: readonly LogEntry[], installedModids: readonly string[]): AttributionResult {
  const byModid = new Map<string, ModGroup>()
  const unattributed: LogEntry[] = []

  for (const entry of entries) {
    if (!isReportable(entry)) continue

    const prefix = MODID_PREFIX.exec(entry.message)
    const phase = prefix ? null : MOD_PHASE.exec(entry.message)
    const modid = prefix ? (prefix[1] as string) : phase ? modidForAssembly(phase[2] as string, installedModids) : undefined

    if (!modid) {
      if (unattributed.length < MAX_UNATTRIBUTED_ENTRIES) unattributed.push(entry)
      continue
    }

    const group = byModid.get(modid) ?? { modid, signal: prefix ? "modid-prefix" : "assembly", errors: 0, warnings: 0, entries: [] }
    if (entry.severity.toLowerCase() === "error") group.errors += 1
    else group.warnings += 1
    if (group.entries.length < MAX_ENTRIES_PER_GROUP) group.entries.push(entry)
    byModid.set(modid, group)
  }

  // Loudest first, so the cap keeps what the player came to read. Map iteration is insertion order,
  // and sort is stable, so two equally noisy Mods stay in the order the log mentioned them.
  const groups = [...byModid.values()].sort((a, b) => b.errors - a.errors || b.warnings - a.warnings)
  return { groups: groups.slice(0, MAX_MOD_GROUPS), unattributed }
}
