import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { appendSample, SAMPLE_INTERVAL_MS } from "@domain/sessions/sampling"
import { steadyClimbVerdict } from "@domain/sessions/steadyClimb"

const MIB = 1024 * 1024
const HOUR_MS = 60 * 60_000

/** A session of `count` readings, `rss` bytes each, that ran for `durationMs`. */
function session(count: number, rss: (index: number) => number, overrides: Partial<PlaySession> = {}): PlaySession {
  return {
    id: "s-1",
    startedAt: 0,
    endedAt: HOUR_MS,
    intervalMs: SAMPLE_INTERVAL_MS,
    partial: false,
    samples: Array.from({ length: count }, (_, index) => ({ t: index * SAMPLE_INTERVAL_MS, rssBytes: rss(index) })),
    ...overrides
  }
}

/** A little noise that never changes the median, so "not flagged" is never an accident of a flat line. */
function jitter(index: number): number {
  return (index % 5) - 2
}

describe("steadyClimbVerdict", () => {
  it("flags a run whose memory only ever went up", () => {
    const climbing = session(240, (index) => (1_000 + index * 4 + jitter(index)) * MIB)
    assert.equal(steadyClimbVerdict(climbing), "steady-climb")
  })

  it("does not flag a run that rose and then plateaued", () => {
    // Up hard for the first quarter, flat for the rest: the total rise clears both floors, so only
    // the per-window step ratio separates this from the real climb above.
    const plateau = session(240, (index) => (1_000 + Math.min(index, 60) * 16 + jitter(index)) * MIB)
    assert.equal(steadyClimbVerdict(plateau), "not-steady-climb")
  })

  it("does not flag a short run", () => {
    const short = session(240, (index) => (1_000 + index * 4) * MIB, { endedAt: 19 * 60_000 })
    assert.equal(steadyClimbVerdict(short), "not-enough-data")
  })

  it("does not flag a run with too few readings in it", () => {
    const sparse = session(59, (index) => (1_000 + index * 20) * MIB)
    assert.equal(steadyClimbVerdict(sparse), "not-enough-data")
  })

  it("does not flag a run the launcher lost track of", () => {
    const partial = session(240, (index) => (1_000 + index * 4) * MIB, { partial: true })
    assert.equal(steadyClimbVerdict(partial), "not-enough-data")
  })

  it("does not flag a noisy but flat run", () => {
    const noisy = session(240, (index) => (2_000 + ((index * 37) % 400) - 200) * MIB)
    assert.equal(steadyClimbVerdict(noisy), "not-steady-climb")
  })

  it("does not flag a big world that starts high and stays there", () => {
    const heavy = session(240, (index) => (6_000 + jitter(index)) * MIB)
    assert.equal(steadyClimbVerdict(heavy), "not-steady-climb")
  })

  it("does not flag a rise that never clears the absolute floor", () => {
    // Every window clears the 3 percent step and the 1.25x ratio, on a small enough base that the
    // whole run gains under 256 MiB.
    const small = session(240, (index) => (100 + index * 0.4) * (MIB / 4))
    assert.equal(steadyClimbVerdict(small), "not-steady-climb")
  })

  it("does not flag a run that gave memory back part way through", () => {
    const released = session(240, (index) => (index === 120 ? 500 : 1_000 + index * 4) * MIB)
    assert.equal(steadyClimbVerdict(released), "not-steady-climb")
  })

  it("does not read a trend off a run with a quarter of its span missing", () => {
    // Readings for the first ten minutes, then an hour and a half of nothing, which is not a shape
    // the recorder writes but is a shape a file on disk can hold. With no reading in the second
    // quarter there is no median to compare it against, and a missing median must never read as a
    // baseline of zero that everything after it clears.
    const gap = session(240, (index) => (1_000 + index * 4) * MIB, {
      endedAt: 100 * 60_000,
      samples: Array.from({ length: 240 }, (_, index) => ({
        t: index < 120 ? index * SAMPLE_INTERVAL_MS : 5_000_000 + (index - 120) * SAMPLE_INTERVAL_MS,
        rssBytes: (1_000 + index * 4) * MIB
      }))
    })
    assert.equal(steadyClimbVerdict(gap), "not-enough-data")
  })

  it("does not flag a high baseline whose whole rise stays under a quarter", () => {
    // The mirror of the case above: 10 GiB gaining 2 GiB, so every window clears the 3 percent step
    // and the whole run clears 256 MiB by a wide margin. Only the 1.25x floor separates the two.
    const shallow = session(240, (index) => (10_000 + (index * 2_000) / 239 + jitter(index)) * MIB)
    assert.equal(steadyClimbVerdict(shallow), "not-steady-climb")
  })
})

/**
 * The verdict against series that have been through the downsampler, which is the only shape it
 * ever sees on disk. A fixture built by hand is evenly spaced; a recorded one has been folded, and
 * a rule that reads position as time silently stops answering once the folding starts.
 */
describe("steadyClimbVerdict on a recorded series", () => {
  /** `minutes` of play at the real interval, downsampled exactly as the recorder downsamples it. */
  function recorded(minutes: number, rss: (fraction: number) => number): PlaySession {
    const readings = minutes * (60_000 / SAMPLE_INTERVAL_MS)
    let samples: PlaySample[] = []
    for (let index = 0; index < readings; index += 1) samples = appendSample(samples, { t: index * SAMPLE_INTERVAL_MS, rssBytes: rss(index / readings) })

    return { id: "s-1", startedAt: 0, endedAt: readings * SAMPLE_INTERVAL_MS, intervalMs: SAMPLE_INTERVAL_MS, partial: false, samples }
  }

  it("flags a textbook climb at every length a session can reach", () => {
    // 1 GiB doubling to 2 GiB, monotone, no dips. Twelve hours is the all-night session the feature
    // exists for, and the one a count-based window never reached.
    for (const minutes of [60, 90, 180, 360, 720]) {
      assert.equal(steadyClimbVerdict(recorded(minutes, (fraction) => (1_000 + 1_000 * fraction) * MIB)), "steady-climb", `${minutes} minutes`)
    }
  })

  it("still does not flag a long run that rose early and then held", () => {
    // Six hours that gain everything in the first half hour. Folding must not turn that into a
    // climb, and the windows must not put the whole plateau in one of them.
    const plateau = recorded(360, (fraction) => (1_000 + Math.min(fraction * 12, 1) * 2_000) * MIB)
    assert.equal(steadyClimbVerdict(plateau), "not-steady-climb")
  })
})
