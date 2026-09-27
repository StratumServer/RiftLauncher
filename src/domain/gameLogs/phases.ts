/**
 * The startup timeline, read from the entry markers the game writes and nothing else.
 *
 * The game logs `Entering runphase <Name>` and never a duration, so every elapsed time here is the
 * difference of two one-second timestamps. The model therefore carries whole seconds, and the view
 * renders "about 7 s". A phase is never reported as taking less than a second: two markers inside
 * the same second are a measurement this log cannot make, not a phase that took no time.
 */

import { toSeconds, type LogEntry } from "@domain/gameLogs/lines"

/** One `Entering runphase` marker, at the second the log stamped it. */
export interface PhaseMark {
  name: string
  atSecond: number
}

/** Something the startup counted out loud. */
export interface Landmark {
  kind: "mods" | "modSystems" | "blocks"
  count: number
}

export interface PhaseTimeline {
  phases: PhaseMark[]
  landmarks: Landmark[]
}

const PHASE = /^Entering runphase (\w+)/
const LANDMARKS: ReadonlyArray<readonly [Landmark["kind"], RegExp]> = [
  ["mods", /^Found (\d+) mods?\b/],
  ["modSystems", /^Instantiated (\d+) mod systems?\b/],
  ["blocks", /^Loaded (\d+) unique blocks?\b/]
]

export function readPhaseTimeline(entries: readonly LogEntry[]): PhaseTimeline {
  const phases: PhaseMark[] = []
  const landmarks: Landmark[] = []

  for (const entry of entries) {
    const phase = PHASE.exec(entry.message)
    // A marker with no readable timestamp cannot be placed on the timeline, so it is left off it.
    if (phase && entry.at) {
      phases.push({ name: phase[1] as string, atSecond: toSeconds(entry.at) })
      continue
    }

    for (const [kind, pattern] of LANDMARKS) {
      const found = pattern.exec(entry.message)
      if (found && !landmarks.some((landmark) => landmark.kind === kind)) landmarks.push({ kind, count: Number(found[1]) })
    }
  }

  return { phases, landmarks }
}
