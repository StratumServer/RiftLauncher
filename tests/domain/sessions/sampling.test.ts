import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  appendSample,
  emptyPlaySessionsDocument,
  MAX_SESSIONS_PER_INSTALLATION,
  normalizePlaySessionsDocument,
  peakRssBytes,
  PLAY_SESSIONS_FORMAT,
  retainSessions,
  SAMPLE_INTERVAL_MS
} from "@domain/sessions/sampling"

const MIB = 1024 * 1024

function series(count: number, rss: (index: number) => number): PlaySample[] {
  return Array.from({ length: count }, (_, index) => ({ t: index * SAMPLE_INTERVAL_MS, rssBytes: rss(index) }))
}

function session(overrides: Partial<PlaySession> = {}): PlaySession {
  return { id: "s-1", startedAt: 1_000, endedAt: 2_000, intervalMs: SAMPLE_INTERVAL_MS, partial: false, samples: series(2, () => 100 * MIB), ...overrides }
}

describe("appendSample", () => {
  it("keeps a single sample as it was read", () => {
    const samples = appendSample([], { t: 0, rssBytes: 500 * MIB })
    assert.deepEqual(samples, [{ t: 0, rssBytes: 500 * MIB }])
  })

  it("keeps a short series whole", () => {
    const samples = series(10, (index) => (100 + index) * MIB).reduce<PlaySample[]>((kept, sample) => appendSample(kept, sample, 16), [])

    assert.equal(samples.length, 10)
    assert.deepEqual(
      samples.map((sample) => sample.t),
      series(10, () => 0).map((_, index) => index * SAMPLE_INTERVAL_MS)
    )
  })

  it("folds a long series in half and keeps its peak exactly", () => {
    const raw = series(40, (index) => (index === 17 ? 900 : 100 + index) * MIB)
    const samples = raw.reduce<PlaySample[]>((kept, sample) => appendSample(kept, sample, 8), [])

    assert.ok(samples.length <= 8, `folded series grew to ${samples.length}`)
    assert.equal(peakRssBytes(samples), 900 * MIB)
    // Folding keeps the earlier timestamp of each pair, so the series still starts where it did
    // and stays in time order.
    assert.equal(samples[0]?.t, 0)
    assert.deepEqual(
      samples.map((sample) => sample.t),
      [...samples].sort((a, b) => a.t - b.t).map((sample) => sample.t)
    )
  })

  it("cannot flatten a monotone rise", () => {
    const samples = series(200, (index) => (100 + index) * MIB).reduce<PlaySample[]>((kept, sample) => appendSample(kept, sample, 16), [])
    const readings = samples.map((sample) => sample.rssBytes)

    assert.deepEqual(
      readings,
      [...readings].sort((a, b) => a - b)
    )
    assert.equal(readings[readings.length - 1], 299 * MIB)
  })

  /**
   * The property the verdict is read off: folding halves the series, and the raw readings that
   * arrive after a fold have to be folded into it rather than appended beside it. Left alone, a
   * long session settles into a coarse head and a fine tail, and every later fold pairs readings
   * across that seam until the early hours of the run are a single point.
   */
  it("keeps a folded series evenly spaced, however long the session runs", () => {
    const readings = 2_000
    let samples: PlaySample[] = []
    for (let index = 0; index < readings; index += 1) samples = appendSample(samples, { t: index * SAMPLE_INTERVAL_MS, rssBytes: (100 + index) * MIB }, 16)

    const gaps = samples.slice(1).map((sample, index) => sample.t - (samples[index]?.t ?? 0))
    assert.equal(new Set(gaps).size, 1, `folded series is unevenly spaced: ${gaps.join(", ")}`)

    // And it still covers the run rather than the tail of it: the last reading kept is within one
    // spacing of where the session actually ended.
    assert.equal(samples[0]?.t, 0)
    assert.ok((samples[samples.length - 1]?.t ?? 0) >= (readings - 1) * SAMPLE_INTERVAL_MS - (gaps[0] ?? 0), "folded series stops well short of the end of the run")
  })

  it("does not let one slow first reading set the resolution of the whole session", () => {
    // The first reading is taken the moment the process exists and the second one interval later,
    // so a sampler that took a minute to answer once is the only wide gap the series will ever see.
    const slowStart: PlaySample[] = [
      { t: 0, rssBytes: 100 * MIB },
      { t: 60_000, rssBytes: 101 * MIB }
    ]
    const samples = Array.from({ length: 18 }, (_, index) => ({ t: 60_000 + (index + 1) * SAMPLE_INTERVAL_MS, rssBytes: (102 + index) * MIB })).reduce<PlaySample[]>(
      (kept, sample) => appendSample(kept, sample),
      slowStart
    )

    assert.equal(samples.length, 20)
  })

  it("averages the CPU readings it folds together and drops a pair that carries none", () => {
    const withCpu = appendSample(
      [
        { t: 0, rssBytes: MIB, cpuPercent: 10 },
        { t: 5, rssBytes: 2 * MIB, cpuPercent: 30 }
      ],
      { t: 10, rssBytes: 3 * MIB },
      2
    )
    assert.equal(withCpu[0]?.cpuPercent, 20)

    const withoutCpu = appendSample(
      [
        { t: 0, rssBytes: MIB },
        { t: 5, rssBytes: 2 * MIB }
      ],
      { t: 10, rssBytes: 3 * MIB },
      2
    )
    assert.equal(withoutCpu[0]?.cpuPercent, undefined)
  })
})

describe("peakRssBytes", () => {
  it("answers zero for a series with nothing in it", () => {
    assert.equal(peakRssBytes([]), 0)
  })
})

describe("normalizePlaySessionsDocument", () => {
  it("round-trips a document it wrote itself", () => {
    const document = retainSessions(emptyPlaySessionsDocument(), session())
    const read = normalizePlaySessionsDocument(JSON.parse(JSON.stringify(document)))

    assert.equal(read.ok, true)
    assert.deepEqual(read.ok && read.document, document)
  })

  it("reads a missing file as a document with no sessions in it", () => {
    const read = normalizePlaySessionsDocument(undefined)
    assert.deepEqual(read, { ok: true, document: { format: PLAY_SESSIONS_FORMAT, sessions: [] } })
  })

  it("refuses a newer format rather than parsing it", () => {
    assert.deepEqual(normalizePlaySessionsDocument({ format: PLAY_SESSIONS_FORMAT + 1, sessions: [] }), { ok: false, problem: "newer-format" })
  })

  it("refuses anything that is not a format-1 document", () => {
    assert.deepEqual(normalizePlaySessionsDocument({ sessions: [] }), { ok: false, problem: "unreadable" })
    assert.deepEqual(normalizePlaySessionsDocument([]), { ok: false, problem: "unreadable" })
    assert.deepEqual(normalizePlaySessionsDocument("{}"), { ok: false, problem: "unreadable" })
  })

  it("drops a malformed session and a malformed sample instead of refusing the file", () => {
    const read = normalizePlaySessionsDocument({
      format: PLAY_SESSIONS_FORMAT,
      sessions: [
        { id: "../escape", startedAt: 0, endedAt: 1, intervalMs: 1, partial: false, samples: [{ t: 0, rssBytes: 1 }] },
        {
          id: "kept",
          startedAt: 0,
          endedAt: 1,
          intervalMs: 1,
          partial: false,
          samples: [
            { t: 0, rssBytes: 1 },
            { t: 1, rssBytes: "big" }
          ]
        },
        { id: "no-samples", startedAt: 0, endedAt: 1, intervalMs: 1, partial: false, samples: [] }
      ]
    })

    assert.equal(read.ok, true)
    assert.deepEqual(read.ok && read.document.sessions.map((kept) => kept.id), ["kept"])
    assert.equal(read.ok && read.document.sessions[0]?.samples.length, 1)
  })
})

describe("retainSessions", () => {
  it("drops the oldest session at one past the cap", () => {
    const filled = Array.from({ length: MAX_SESSIONS_PER_INSTALLATION }, (_, index) => session({ id: `s-${index}` })).reduce(
      (document, recorded) => retainSessions(document, recorded),
      emptyPlaySessionsDocument()
    )
    assert.equal(filled.sessions.length, MAX_SESSIONS_PER_INSTALLATION)

    const overflowed = retainSessions(filled, session({ id: "newest" }))

    assert.equal(overflowed.sessions.length, MAX_SESSIONS_PER_INSTALLATION)
    assert.equal(overflowed.sessions[0]?.id, "newest")
    assert.equal(
      overflowed.sessions.some((kept) => kept.id === "s-0"),
      false
    )
  })
})
