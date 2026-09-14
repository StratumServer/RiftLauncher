/**
 * Play sessions: what the launcher measures of the game process while it runs (#461).
 *
 * The launcher is the parent of every session, so the one thing it can answer from outside is
 * what the operating system says about a process it started: resident memory, CPU time, elapsed
 * time. Nothing here can see inside the game, so nothing here can be attributed to a Mod.
 *
 * The series live in their own file under the launcher's user data, never in config.json, which
 * is rewritten whole on every renderer change. The `format` field is what lets a later change
 * refuse a newer file instead of guessing at it, the same way domain/mods/profiles.ts does.
 *
 * The shapes themselves (PlaySample, PlaySession, PlaySessionsDocument) are declared in
 * src/global.d.ts, because they cross the IPC boundary and both sides have to name them.
 */

/** How often the game process is read while it runs. */
export const SAMPLE_INTERVAL_MS = 5_000

/** One hour of play fits under this unfolded, which is what the folding below is sized against. */
export const MAX_SAMPLES_PER_SESSION = 720

/** Twenty evenings, so a player comparing "with mods" against "without" has both in front of them. */
export const MAX_SESSIONS_PER_INSTALLATION = 20

/**
 * Whether a fresh config measures at all.
 *
 * On, because the cost is one timer and a small local file and playtime is already recorded. Off is
 * one click away, because measuring a player's machine when nobody asked still deserves a switch.
 */
export const DEFAULT_MEASURE_PLAY_SESSIONS = true

/** The only format this build reads or writes. A newer one is refused, not parsed. */
export const PLAY_SESSIONS_FORMAT = 1

export type PlaySessionsProblem = "newer-format" | "unreadable"

export type PlaySessionsNormalized = { ok: true; document: PlaySessionsDocument } | { ok: false; problem: PlaySessionsProblem }

const MAX_SESSION_ID_LENGTH = 64
const SESSION_ID = /^[A-Za-z0-9_-]+$/

export function emptyPlaySessionsDocument(): PlaySessionsDocument {
  return { format: PLAY_SESSIONS_FORMAT, sessions: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The mean of the readings that carry a CPU figure, or nothing when neither does. */
function meanCpu(first: PlaySample, second: PlaySample): number | undefined {
  const readings = [first.cpuPercent, second.cpuPercent].filter((value): value is number => value !== undefined)
  if (readings.length === 0) return undefined
  return readings.reduce((total, value) => total + value, 0) / readings.length
}

/**
 * Halves a series by folding each consecutive pair into one sample: the earlier timestamp, the
 * HIGHER of the two memory readings, the mean of the CPU readings.
 *
 * Max rather than mean or decimation, deliberately. Taking the maximum preserves the peak exactly,
 * which is the one number a row reports, and it cannot flatten a monotone rise into a plateau the
 * way dropping every other sample can. What it does cost is the dips: a folded series reads
 * slightly higher than the raw one, so a session folded twice looks a little flatter at the bottom.
 */
function mergePair(first: PlaySample, second: PlaySample): PlaySample {
  const cpuPercent = meanCpu(first, second)
  return { t: first.t, rssBytes: Math.max(first.rssBytes, second.rssBytes), ...(cpuPercent === undefined ? {} : { cpuPercent }) }
}

function foldPairs(samples: readonly PlaySample[]): PlaySample[] {
  const folded: PlaySample[] = []

  for (let index = 0; index < samples.length; index += 2) {
    const first = samples[index]
    if (!first) continue
    const second = samples[index + 1]
    folded.push(second ? mergePair(first, second) : first)
  }

  return folded
}

/**
 * The tightest spacing in the series, which is the resolution the folds so far have settled on.
 *
 * The minimum rather than the first gap: one reading the sampler took late would otherwise be read
 * as the resolution of the whole series and swallow every reading after it.
 */
function tightestSpacing(samples: readonly PlaySample[]): number {
  let tightest = Number.POSITIVE_INFINITY
  for (let index = 1; index < samples.length; index += 1) tightest = Math.min(tightest, (samples[index]?.t ?? 0) - (samples[index - 1]?.t ?? 0))
  return Number.isFinite(tightest) ? tightest : 0
}

/**
 * Adds one reading to a series, folding it in half first when the push would pass `cap`.
 *
 * This is the whole downsampler. A session under the cap is kept exactly as it was read; a longer
 * one keeps its shape at half the resolution, then a quarter, and so on, so an all-night session
 * costs the same file space as an hour of it.
 *
 * Folding alone is not enough to hold that promise. A fold halves the whole series, and the raw
 * readings appended after it arrive at the original interval, so the series would drift back into a
 * coarse head and a fine tail, and the next fold would pair readings across that seam. Repeated,
 * that erases the early hours of a long session outright rather than halving them. So a reading
 * that lands inside the spacing the last fold settled on is merged into the reading before it,
 * on the same terms a fold uses, and the series stays evenly spaced at every length.
 */
export function appendSample(samples: readonly PlaySample[], sample: PlaySample, cap: number = MAX_SAMPLES_PER_SESSION): PlaySample[] {
  // A cap under two can never fit a fold plus the new sample, so it would grow forever.
  const ceiling = Math.max(2, Math.trunc(cap))
  const last = samples[samples.length - 1]
  const spacing = tightestSpacing(samples)

  // Three readings in, before the spacing means anything: a slow first reading is otherwise the only
  // gap there is to measure, and would set the resolution of the whole session from one late read.
  if (last && samples.length > 2 && spacing > 0 && sample.t - last.t < spacing) return [...samples.slice(0, -1), mergePair(last, sample)]

  return [...(samples.length + 1 > ceiling ? foldPairs(samples) : samples), sample]
}

/** The highest memory reading in a series, or zero for an empty one. */
export function peakRssBytes(samples: readonly PlaySample[]): number {
  return samples.reduce((peak, sample) => Math.max(peak, sample.rssBytes), 0)
}

function normalizeSample(value: unknown): PlaySample | undefined {
  if (!isRecord(value)) return undefined
  const { t, rssBytes, cpuPercent } = value
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return undefined
  if (typeof rssBytes !== "number" || !Number.isFinite(rssBytes) || rssBytes < 0) return undefined
  const cpu = typeof cpuPercent === "number" && Number.isFinite(cpuPercent) && cpuPercent >= 0 ? cpuPercent : undefined
  return { t, rssBytes, ...(cpu === undefined ? {} : { cpuPercent: cpu }) }
}

function normalizeSession(value: unknown): PlaySession | undefined {
  if (!isRecord(value) || !Array.isArray(value.samples)) return undefined
  const { id, startedAt, endedAt, intervalMs, partial } = value
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_SESSION_ID_LENGTH || !SESSION_ID.test(id)) return undefined
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0) return undefined
  if (typeof endedAt !== "number" || !Number.isFinite(endedAt) || endedAt < startedAt) return undefined
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) return undefined

  const samples = value.samples.flatMap((sample) => normalizeSample(sample) ?? []).slice(0, MAX_SAMPLES_PER_SESSION)
  if (samples.length === 0) return undefined
  return { id, startedAt, endedAt, intervalMs, partial: partial === true, samples }
}

/**
 * Reads a sessions document as this build understands it. Never throws.
 *
 * A missing file is an empty document. A newer format is refused as it stands, so this build never
 * writes back a lossy copy of one. Anything that is not a format-1 document is unreadable and is
 * left alone for the same reason. Inside a format-1 document the rules are tolerant: a malformed
 * session or sample is dropped, and the counts are cut to the caps.
 */
export function normalizePlaySessionsDocument(value: unknown): PlaySessionsNormalized {
  if (value === undefined) return { ok: true, document: emptyPlaySessionsDocument() }
  if (!isRecord(value)) return { ok: false, problem: "unreadable" }
  if (typeof value.format === "number" && Number.isInteger(value.format) && value.format > PLAY_SESSIONS_FORMAT) return { ok: false, problem: "newer-format" }
  if (value.format !== PLAY_SESSIONS_FORMAT) return { ok: false, problem: "unreadable" }

  const sessions = (Array.isArray(value.sessions) ? value.sessions : []).flatMap((session) => normalizeSession(session) ?? []).slice(0, MAX_SESSIONS_PER_INSTALLATION)
  return { ok: true, document: { format: PLAY_SESSIONS_FORMAT, sessions } }
}

/** Puts `session` at the head of the document and drops whatever falls off the end. Newest first. */
export function retainSessions(document: PlaySessionsDocument, session: PlaySession): PlaySessionsDocument {
  return { format: PLAY_SESSIONS_FORMAT, sessions: [session, ...document.sessions].slice(0, MAX_SESSIONS_PER_INSTALLATION) }
}
