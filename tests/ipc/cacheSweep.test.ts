import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fse from "fs-extra"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import "./helpers/electronMock"

import { CACHE_SWEEP_CONCURRENCY_LIMIT, sweepCacheFolder } from "@src/ipc/cacheSweep"

/**
 * The bound from issue #354. A measured startup evicted 1,664 entries and the
 * old `Promise.all` started 1,664 stat-and-remove pairs at once. This holds the
 * shared walk to a fixed number of concurrent filesystem calls, so the number
 * below is written out rather than read from the constant: a bound raised past
 * what the sweep actually needs has to fail here.
 */
const DOOMED_ENTRY_COUNT = 40

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-cache-sweep-"))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(workspace, { recursive: true, force: true })
})

describe("sweepCacheFolder", () => {
  it("keeps at most eight filesystem calls in flight, however many entries are doomed", async () => {
    for (let index = 0; index < DOOMED_ENTRY_COUNT; index += 1) writeFileSync(join(workspace, `entry-${index}.json`), "x".repeat(index + 1))

    let inFlight = 0
    let peakInFlight = 0
    const realStat = fse.stat.bind(fse)
    const realRemove = fse.remove.bind(fse)

    function tracked<T>(work: () => Promise<T>): Promise<T> {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      return work().finally(() => {
        inFlight -= 1
      })
    }

    vi.spyOn(fse, "stat").mockImplementation(((path: string) => tracked(() => realStat(path))) as typeof fse.stat)
    vi.spyOn(fse, "remove").mockImplementation(((path: string) => tracked(() => realRemove(path))) as typeof fse.remove)

    await sweepCacheFolder({
      folder: workspace,
      origin: "[test] [cacheSweep]",
      subject: "the test cache",
      accepts: () => true,
      recencyOf: (stats) => stats.mtimeMs,
      // Everything goes, so the removal fan-out is as wide as the folder.
      plan: (entries) => entries.map((entry) => entry.name)
    })

    assert.ok(peakInFlight <= 8, `expected at most 8 concurrent filesystem calls, saw ${peakInFlight}`)
    // Without the bound this reaches DOOMED_ENTRY_COUNT; a sweep that ran one
    // file at a time would pass the line above for the wrong reason.
    assert.ok(peakInFlight > 1, `expected the sweep to overlap its work, saw ${peakInFlight}`)
    assert.equal(CACHE_SWEEP_CONCURRENCY_LIMIT, 8)

    // The bound changes when the work happens, not what it does.
    for (let index = 0; index < DOOMED_ENTRY_COUNT; index += 1) assert.equal(existsSync(join(workspace, `entry-${index}.json`)), false)
  })

  it("leaves an entry whose timestamp moved since the snapshot", async () => {
    const kept = join(workspace, "rewritten.json")
    const removed = join(workspace, "stale.json")
    writeFileSync(kept, "before")
    writeFileSync(removed, "stale")

    const realStat = fse.stat.bind(fse)
    let snapshotTaken = false
    vi.spyOn(fse, "stat").mockImplementation((async (path: string) => {
      const stats = await realStat(path)
      // The re-stat, not the snapshot: a concurrent writer got there first.
      if (path === kept && snapshotTaken) return { ...stats, isFile: () => true, mtimeMs: stats.mtimeMs + 1_000 } as fse.Stats
      if (path === kept) snapshotTaken = true
      return stats
    }) as typeof fse.stat)

    await sweepCacheFolder({
      folder: workspace,
      origin: "[test] [cacheSweep]",
      subject: "the test cache",
      accepts: () => true,
      recencyOf: (stats) => stats.mtimeMs,
      plan: (entries) => entries.map((entry) => entry.name)
    })

    assert.equal(existsSync(kept), true)
    assert.equal(existsSync(removed), false)
  })
})
