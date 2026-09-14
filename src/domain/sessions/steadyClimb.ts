/**
 * The one verdict the launcher draws from a session's memory curve (#461).
 *
 * What it says: memory went up across the whole run and never came back down. That is all. It
 * never names a Mod, it never says the game or a Mod is at fault, and "not-steady-climb" is not a
 * clean bill of health: the sampler stands outside the process, so a leak in a Mod, a leak in the
 * game and a very large world all look the same from here.
 *
 * The verdict is computed on read and never stored, so a threshold corrected in a patch applies to
 * every session already on disk instead of needing a rewrite of the history.
 *
 * ponytail: four fixed windows, their medians, and a no-regression check is the whole ceiling. It
 * cannot separate a slow climb from a staircase of world loads, and it says nothing about the
 * shape between the windows. The upgrade path is a least-squares fit over the samples with a
 * confidence floor, which is worth doing once there are real curves to fit it against; guessing at
 * one now would be a cleverer rule with the same evidence behind it.
 */

export type SteadyClimbVerdict = "steady-climb" | "not-steady-climb" | "not-enough-data"

/** Under this, a curve is the game loading a world rather than a session with a trend in it. */
const MIN_SESSION_MS = 20 * 60_000

/** At five seconds a sample, sixty of them is five minutes of readings inside that session. */
const MIN_SAMPLES = 60

/** How much each window has to clear the one before it. A bare ">" would pass on noise alone. */
const WINDOW_STEP_RATIO = 1.03

/** Both floors have to clear: a quarter more memory, and at least this much of it in absolute terms. */
const MIN_RISE_BYTES = 256 * 1024 * 1024
const MIN_RISE_RATIO = 1.25

const WINDOW_COUNT = 4

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return 0
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * Splits the samples into four consecutive equal-length time windows, placing each reading by its
 * own timestamp rather than by its position in the array.
 *
 * Position is not time here. appendSample folds a session in half every time it passes the sample
 * cap, so a long series settles into a head whose readings each stand for eight of the raw ones and
 * a tail of raw readings. Counting the array into quarters hands the first window the bulk of an
 * all-night run and squeezes the other three into the last hour of it, which flattens the very
 * trend this is reading. Equal time spans are the same thing as equal counts while the series is
 * still raw, so a short session is unaffected.
 */
function timeWindows(samples: readonly PlaySample[]): PlaySample[][] {
  const start = samples[0]?.t ?? 0
  const span = (samples[samples.length - 1]?.t ?? 0) - start
  const windows: PlaySample[][] = Array.from({ length: WINDOW_COUNT }, () => [])

  for (const sample of samples) {
    const index = span > 0 ? Math.min(WINDOW_COUNT - 1, Math.floor(((sample.t - start) / span) * WINDOW_COUNT)) : 0
    windows[index]?.push(sample)
  }

  return windows
}

/**
 * Whether this session's memory only ever went up.
 *
 * Guards first: a session shorter than twenty minutes, one with fewer than sixty samples, one the
 * launcher lost track of part way through, or one with a quarter of its span holding no reading at
 * all answers "not-enough-data", because none of the four carries enough of a run to read a trend
 * off.
 *
 * Then every one of these has to hold, or the answer is "not-steady-climb": each window's median at
 * least 3 percent above the one before it, the last window at least 256 MiB and a quarter above the
 * first, and no sample after the first window falling back below the first window's median. The
 * step ratio is what separates a real climb from rise-then-plateau; the no-regression check is what
 * separates it from a session that grew, freed and grew again.
 */
export function steadyClimbVerdict(session: PlaySession): SteadyClimbVerdict {
  if (session.partial) return "not-enough-data"
  if (session.endedAt - session.startedAt < MIN_SESSION_MS) return "not-enough-data"
  if (session.samples.length < MIN_SAMPLES) return "not-enough-data"

  const windows = timeWindows(session.samples)
  // A quarter of the run with no reading in it has no median to compare, so there is no trend here.
  if (windows.some((window) => window.length === 0)) return "not-enough-data"

  const [first = 0, second = 0, third = 0, last = 0] = windows.map((window) => median(window.map((sample) => sample.rssBytes)))

  if (second < first * WINDOW_STEP_RATIO) return "not-steady-climb"
  if (third < second * WINDOW_STEP_RATIO) return "not-steady-climb"
  if (last < third * WINDOW_STEP_RATIO) return "not-steady-climb"
  if (last - first < MIN_RISE_BYTES) return "not-steady-climb"
  if (last < first * MIN_RISE_RATIO) return "not-steady-climb"

  const afterFirstWindow = windows.slice(1).flat()
  if (afterFirstWindow.some((sample) => sample.rssBytes < first)) return "not-steady-climb"

  return "steady-climb"
}
