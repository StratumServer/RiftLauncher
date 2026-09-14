/**
 * `client-crash.txt`: a header block, then the trace. No per-line timestamps, and no single
 * grammar across game versions, so every field here is optional and an unreadable one is left out
 * rather than guessed at.
 *
 * Three independent signals name a culprit in the header, and this reads all three: the mod the
 * game blamed, the roster of loaded mods, and the Harmony ids involved. What the caller does with
 * them differs, see report.ts: the blamed mod is a fact the file states, a Harmony id is a hint.
 */

import { toTimestamp, boundLine, type LogTimestamp } from "@domain/gameLogs/lines"

export interface CrashMod {
  modid: string
  version: string
}

export interface CrashSummary {
  /** Absent when the header carried no timestamp this knows how to read, or none at all. */
  at?: LogTimestamp
  /** The mod the game itself blamed, when it named one. */
  blamedModid?: string
  blamedVersion?: string
  loadedMods: CrashMod[]
  harmonyIds: string[]
  exceptionType?: string
  exceptionMessage?: string
  frames: string[]
}

/** Enough of a trace to recognise the failure. The rest is for the log file, and the folder button. */
export const MAX_TRACE_FRAMES = 20

const FRAME = /^ {3}at /
const BLAMED = /Critical error occurred in the following mod: (\S+?)@(\S+)/
const LOADED_MODS = /^Loaded Mods:\s*(.*)$/
const HARMONY_IDS = /^Involved Harmony IDs:\s*(.*)$/
const EXCEPTION = /^([\w.+]+(?:Exception|Error)): (.*)$/

/** `22.02.2026 20:39:11:` and `22.2.2026 20:39:11:`, the shape 1.22 writes. */
const DOTTED_STAMP = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2}):(\d{2}):/
/**
 * `16/10/2022 12:19:11 PM:`, what older builds wrote on a machine whose locale asked for it.
 *
 * Read day first, the way every other timestamp this game writes is spelled. A file from a
 * month-first machine dated on or before the twelfth is therefore read with the day and month
 * swapped, and there is nothing in the file that says which it was. It shifts the one line that
 * reports when the crash happened; nothing else in the report is derived from it.
 */
const SLASHED_STAMP = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i

function toHour24(hour: number, meridiem: string): number {
  const lowered = meridiem.toLowerCase()
  if (lowered === "pm") return hour === 12 ? 12 : hour + 12
  return hour === 12 ? 0 : hour
}

function readStamp(line: string): LogTimestamp | undefined {
  const dotted = DOTTED_STAMP.exec(line)
  if (dotted) return toTimestamp(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]), Number(dotted[4]), Number(dotted[5]), Number(dotted[6]))

  const slashed = SLASHED_STAMP.exec(line)
  if (slashed) return toTimestamp(Number(slashed[3]), Number(slashed[2]), Number(slashed[1]), toHour24(Number(slashed[4]), slashed[7] as string), Number(slashed[5]), Number(slashed[6]))

  return undefined
}

function splitList(value: string): string[] {
  return value
    .split(", ")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function toCrashMod(entry: string): CrashMod | undefined {
  const at = entry.lastIndexOf("@")
  if (at <= 0) return undefined
  return { modid: entry.slice(0, at), version: entry.slice(at + 1) }
}

/** The summary, or null when the file holds nothing this recognises as a crash. */
export function parseCrashFile(text: string): CrashSummary | null {
  const lines = text.split(/\r?\n/)
  const firstFrame = lines.findIndex((line) => FRAME.test(line))
  const header = firstFrame === -1 ? lines : lines.slice(0, firstFrame)

  const summary: CrashSummary = { loadedMods: [], harmonyIds: [], frames: [] }

  for (const line of header) {
    summary.at ??= readStamp(line)

    const blamed = BLAMED.exec(line)
    if (blamed && !summary.blamedModid) {
      summary.blamedModid = blamed[1] as string
      summary.blamedVersion = blamed[2] as string
    }

    const loaded = LOADED_MODS.exec(line)
    if (loaded && summary.loadedMods.length === 0) summary.loadedMods = splitList(loaded[1] as string).flatMap((entry) => toCrashMod(entry) ?? [])

    const harmony = HARMONY_IDS.exec(line)
    if (harmony && summary.harmonyIds.length === 0) summary.harmonyIds = splitList(harmony[1] as string)

    const exception = EXCEPTION.exec(line)
    if (exception && !summary.exceptionType) {
      summary.exceptionType = exception[1] as string
      summary.exceptionMessage = boundLine(exception[2] as string)
    }
  }

  if (firstFrame !== -1) {
    summary.frames = lines
      .slice(firstFrame)
      .filter((line) => FRAME.test(line))
      .slice(0, MAX_TRACE_FRAMES)
      .map((line) => boundLine(line.trim()))
  }

  const empty = !summary.blamedModid && !summary.exceptionType && summary.loadedMods.length === 0 && summary.frames.length === 0
  return empty ? null : summary
}
