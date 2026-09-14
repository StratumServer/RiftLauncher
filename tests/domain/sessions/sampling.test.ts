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
