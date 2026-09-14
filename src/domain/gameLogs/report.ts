/**
 * One session's logs, turned into something a player can read and paste somewhere.
 *
 * Everything the report holds is redacted here, before it leaves the main process: the pattern
 * redactor for paths and token-shaped values, then the player's own email and player name by value.
 * Nothing read out of a game log is ever written to the launcher's own log, not even at verbose.
 *
 * What this must never claim: that a Mod caused something the log did not name, that a phase took
 * less than a second, or that a dependency should be installed. It reports the loader's own
 * complaint and stops.
 */

import { attributeEntries, type AttributionSignal } from "@domain/gameLogs/attribution"
import { parseCrashFile } from "@domain/gameLogs/crashFile"
import { boundLine, parseLogLines, type LogEntry, type LogTimestamp } from "@domain/gameLogs/lines"
import { readPhaseTimeline, type Landmark } from "@domain/gameLogs/phases"
import { maskValues, redactSensitiveText } from "@domain/redaction"

/**
 * How many continuation lines one log entry keeps in the report.
 *
 * The parser keeps forty, which is what a whole stack trace needs while it is being read. The
 * report is bounded far tighter because it crosses IPC and is rendered: six frames name the failure,
 * and "Open logs folder" is the escape hatch for the rest.
 */
export const REPORT_TRACE_LINES = 6

export type VerdictKind = "crashed-in-mod" | "crashed" | "errors" | "clean"

export interface ReportLine {
  /** `HH:MM:SS`, absent when the line carried no readable timestamp. */
  clock?: string
  severity: string
  text: string
  continuation: string[]
}

export interface ReportModGroup {
  modid: string
  /** The Mod's own name, when the launcher recognises the id. Absent means the id is the answer. */
  name?: string
  signal: AttributionSignal
  errors: number
  warnings: number
  lines: ReportLine[]
}

export interface ReportCrash {
  /** The Mod the crash file blamed, by name when the launcher knows it. */
  modLabel?: string
  modVersion?: string
  exceptionType?: string
  exceptionMessage?: string
  frames: string[]
  clock?: string
  /** Installed Mods other than the blamed one whose Harmony patches were involved. A hint, not a cause. */
  otherPatchLabels: string[]
}

export interface ReportPhase {
  name: string
  /** Whole seconds to the next marker. Absent for the last phase, and for a gap the log cannot measure. */
  seconds?: number
}

export interface SessionReport {
  verdict: { kind: VerdictKind; modLabel?: string }
  source: {
    /** The file the lines came from, so a reader can tell which log they are looking at. */
    fileName: string
    /** When that file was last written, epoch milliseconds, for the view to render in the player's locale. */
    lastWrittenAtMs?: number
    /** True when the middle of the file was not read. */
    truncated: boolean
  }
  crash?: ReportCrash
  mods: ReportModGroup[]
  unattributed: ReportLine[]
  startup: { phases: ReportPhase[]; landmarks: Landmark[] }
}

export interface InstalledModRef {
  modid: string
  name?: string
}

export interface SessionReportInput {
  /**
   * The main log and where it came from. Named rather than assumed so the local server (#2) can
   * pass `server-main.log` to the same functions: the grammar is identical.
   */
  mainLog?: { fileName: string; text: string; lastWrittenAtMs?: number; truncated?: boolean }
  crashFile?: { text: string }
  installedMods?: readonly InstalledModRef[]
  /** The player's own email and player name, masked by value wherever they appear. */
  accountValues?: readonly string[]
}

function clock(at: LogTimestamp | undefined): string | undefined {
  if (!at) return undefined
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${pad(at.h)}:${pad(at.mi)}:${pad(at.s)}`
}

export function buildSessionReport(input: SessionReportInput): SessionReport {
  const accountValues = input.accountValues ?? []
  const clean = (value: string): string => maskValues(redactSensitiveText(value), accountValues)
  const installedMods = input.installedMods ?? []
  const nameFor = (modid: string): string | undefined => installedMods.find((mod) => mod.modid.toLowerCase() === modid.toLowerCase())?.name
  const labelFor = (modid: string): string => nameFor(modid) ?? modid

  const toLine = (entry: LogEntry): ReportLine => ({
    clock: clock(entry.at),
    severity: entry.severity,
    text: clean(entry.message),
    continuation: entry.continuation.slice(0, REPORT_TRACE_LINES).map(clean)
  })

  const entries = input.mainLog ? parseLogLines(input.mainLog.text) : []
  const installedModids = installedMods.map((mod) => mod.modid)
  const attributed = attributeEntries(entries, installedModids)
  const timeline = readPhaseTimeline(entries)

  const crashSummary = input.crashFile ? parseCrashFile(input.crashFile.text) : null
  const crash: ReportCrash | undefined = crashSummary
    ? {
        // Both go through the redactor: the crash file spells the blamed mod as `modid@version`,
        // where an unrecognised modid is answered with the raw text and a version built from a
        // source tree is the mod author's own path.
        modLabel: crashSummary.blamedModid ? clean(boundLine(labelFor(crashSummary.blamedModid))) : undefined,
        modVersion: crashSummary.blamedVersion ? clean(boundLine(crashSummary.blamedVersion)) : undefined,
        exceptionType: crashSummary.exceptionType,
        exceptionMessage: crashSummary.exceptionMessage ? clean(crashSummary.exceptionMessage) : undefined,
        frames: crashSummary.frames.map(clean),
        clock: clock(crashSummary.at),
        // A Harmony id is matched the same way an assembly is, and only ever adds a note. It names
        // a Mod whose patch was on the stack, which is not the same thing as the Mod at fault.
        otherPatchLabels: [
          ...new Set(
            crashSummary.harmonyIds
              .map((id) => installedModids.find((modid) => modid.toLowerCase() === (id.split(".")[0] ?? "").toLowerCase()))
              .filter((modid): modid is string => modid !== undefined && modid.toLowerCase() !== (crashSummary.blamedModid ?? "").toLowerCase())
              .map((modid) => clean(boundLine(labelFor(modid))))
          )
        ]
      }
    : undefined

  const mods: ReportModGroup[] = attributed.groups.map((group) => ({
    modid: clean(boundLine(group.modid)),
    name: nameFor(group.modid) ? clean(boundLine(nameFor(group.modid) as string)) : undefined,
    // The crash file naming a Mod outranks either log-line rule: it is the game's own verdict.
    signal: crashSummary?.blamedModid?.toLowerCase() === group.modid.toLowerCase() ? "crash-file" : group.signal,
    errors: group.errors,
    warnings: group.warnings,
    lines: group.entries.map(toLine)
  }))

  const phases: ReportPhase[] = timeline.phases.map((phase, index) => {
    const next = timeline.phases[index + 1]
    const seconds = next ? next.atSecond - phase.atSecond : 0
    // Whole seconds are all this log measures, so a difference of zero is a gap it cannot report,
    // not a phase that took no time. Nothing is claimed for it.
    return seconds > 0 ? { name: phase.name, seconds } : { name: phase.name }
  })

  // Decide the verdict from every parsed entry before attribution applies its display caps. A
  // bounded report may omit an error from the visible list, but it must not say that no errors
  // were logged when the source contains one.
  const anyErrors = entries.some((entry) => entry.severity.toLowerCase() === "error")
  const verdict: SessionReport["verdict"] = crash ? (crash.modLabel ? { kind: "crashed-in-mod", modLabel: crash.modLabel } : { kind: "crashed" }) : anyErrors ? { kind: "errors" } : { kind: "clean" }

  return {
    verdict,
    source: { fileName: input.mainLog?.fileName ?? "", lastWrittenAtMs: input.mainLog?.lastWrittenAtMs, truncated: input.mainLog?.truncated ?? false },
    ...(crash ? { crash } : {}),
    mods,
    unattributed: attributed.unattributed.map(toLine),
    startup: { phases, landmarks: timeline.landmarks }
  }
}

const VERDICT_TEXT: Readonly<Record<VerdictKind, string>> = {
  "crashed-in-mod": "The game crashed in",
  crashed: "The game crashed.",
  errors: "The game exited with errors.",
  clean: "No errors were logged."
}

const SIGNAL_TEXT: Readonly<Record<AttributionSignal, string>> = {
  "modid-prefix": "named by the log line",
  assembly: "named by the assembly",
  "crash-file": "named by the crash file"
}

/**
 * The report as plain text, for the clipboard.
 *
 * English, deliberately: it is written to be pasted into a bug thread or a Discord channel, where
 * the audience is the mod author and the people who can help. Everything in it has already been
 * redacted by `buildSessionReport`; this only lays it out.
 */
export function formatReportText(report: SessionReport): string {
  const out: string[] = []
  const line = (line: ReportLine): string => `  ${line.clock ? `${line.clock} ` : ""}[${line.severity}] ${line.text}`

  out.push(report.verdict.kind === "crashed-in-mod" ? `${VERDICT_TEXT["crashed-in-mod"]} ${report.verdict.modLabel}.` : VERDICT_TEXT[report.verdict.kind])
  if (report.source.fileName) out.push(`From ${report.source.fileName}.`)
  if (report.source.truncated) out.push("The middle of this log was not read.")

  if (report.crash) {
    out.push("", "Crash")
    if (report.crash.modLabel) out.push(`  Blamed Mod: ${report.crash.modLabel}${report.crash.modVersion ? ` ${report.crash.modVersion}` : ""}`)
    if (report.crash.exceptionType) out.push(`  ${report.crash.exceptionType}: ${report.crash.exceptionMessage ?? ""}`)
    for (const label of report.crash.otherPatchLabels) out.push(`  A patch from ${label} was involved.`)
    for (const frame of report.crash.frames) out.push(`  ${frame}`)
  }

  if (report.mods.length > 0) {
    out.push("", "By Mod")
    for (const mod of report.mods) {
      out.push(`  ${mod.name ?? mod.modid} (${mod.errors} errors, ${mod.warnings} warnings, ${SIGNAL_TEXT[mod.signal]})`)
      for (const entry of mod.lines) {
        out.push(`  ${line(entry)}`)
        for (const frame of entry.continuation) out.push(`      ${frame}`)
      }
    }
  }

  if (report.startup.phases.length > 0 || report.startup.landmarks.length > 0) {
    out.push("", "Startup")
    for (const phase of report.startup.phases) out.push(`  ${phase.name}${phase.seconds ? `, about ${phase.seconds} s` : ""}`)
    for (const landmark of report.startup.landmarks) out.push(`  ${landmark.kind}: ${landmark.count}`)
  }

  if (report.unattributed.length > 0) {
    out.push("", "Anything else")
    for (const entry of report.unattributed) out.push(line(entry))
  }

  return out.join("\n")
}
