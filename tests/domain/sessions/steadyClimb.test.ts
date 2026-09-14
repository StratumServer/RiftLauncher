import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { SAMPLE_INTERVAL_MS } from "@domain/sessions/sampling"
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
})
