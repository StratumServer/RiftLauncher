/**
 * The grammar of a Vintage Story client log line: `d.M.yyyy H:mm:ss [Severity] message`, day and
 * month not zero-padded, 24-hour clock.
 *
 * Tolerant by construction, because this reads text several game versions and hundreds of mod
 * authors produce. A line that does not match is kept as a continuation of the entry before it,
 * which is how a stack trace arrives. A timestamp that matches the shape but names no real date
 * leaves `at` absent rather than carrying a wrong one, and the entry keeps its severity and message.
 */

/** A moment as the log spells it, whole seconds, no timezone. The log carries no more than this. */
export interface LogTimestamp {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
}

export interface LogEntry {
  /** Absent when the line named a date the calendar does not have. */
  at?: LogTimestamp
  /** `Notification`, `Event`, `Warning`, `Error`, `Debug`, or whatever a future build writes. */
  severity: string
  message: string
  /** The lines that followed and matched nothing: a stack trace, usually. */
  continuation: string[]
}

/** What a stack trace needs, and the ceiling on what one entry can drag along with it. */
export const MAX_CONTINUATION_LINES = 40

/** Past this a log line is not a sentence any more, it is a payload. Applied to every string kept. */
export const MAX_LINE_CHARS = 500

const LINE = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) \[(\w+)\] (.*)$/

/** Trims one line to {@link MAX_LINE_CHARS}, keeping the head, which is where the meaning is. */
export function boundLine(value: string): string {
  return value.length > MAX_LINE_CHARS ? value.slice(0, MAX_LINE_CHARS) : value
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * A timestamp only when the numbers name a date that exists. February 29th is admitted in every
 * year: the log carries no timezone and this is a sanity check, not a calendar.
 */
export function toTimestamp(y: number, mo: number, d: number, h: number, mi: number, s: number): LogTimestamp | undefined {
  if (mo < 1 || mo > 12 || d < 1 || d > (DAYS_IN_MONTH[mo - 1] as number)) return undefined
  if (h > 23 || mi > 59 || s > 59) return undefined
  return { y, mo, d, h, mi, s }
}

/** One timestamp as whole seconds on a single axis, so two of them can be subtracted across a midnight. */
export function toSeconds(at: LogTimestamp): number {
  return Math.floor(Date.UTC(at.y, at.mo - 1, at.d, at.h, at.mi, at.s) / 1000)
}

export function parseLogLines(text: string): LogEntry[] {
  const entries: LogEntry[] = []

  for (const line of text.split(/\r?\n/)) {
    const found = LINE.exec(line)

    if (!found) {
      const current = entries[entries.length - 1]
      // A leading run that matches nothing is what a tail read produces: half of whatever entry the
      // cut landed inside. It belongs to no entry here, so it is dropped rather than invented.
      if (!current || line.trim().length === 0) continue
      if (current.continuation.length < MAX_CONTINUATION_LINES) current.continuation.push(boundLine(line))
      continue
    }

    entries.push({
      // The line spells the date day-first; toTimestamp takes it year-first.
      at: toTimestamp(Number(found[3]), Number(found[2]), Number(found[1]), Number(found[4]), Number(found[5]), Number(found[6])),
      severity: found[7] as string,
      message: boundLine(found[8] as string),
      continuation: []
    })
  }

  return entries
}
