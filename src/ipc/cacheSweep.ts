import fse from "fs-extra"
import { join } from "node:path"

import { ConcurrencyLimiter } from "@domain/concurrencyLimiter"
import { logMessage } from "@src/utils/logManager"

/**
 * The walk both disk caches do when they prune themselves: list the folder,
 * snapshot what is in it, hand that to the cache's own eviction planner, then
 * delete what it named, re-reading each file's timestamp first so a concurrent
 * write is never removed out from under its writer.
 *
 * The two caches used to carry a copy of this each. They differ in the folder,
 * which names they own, which timestamp is their recency signal, and how they
 * pick losers, and in nothing else, so a safety or concurrency fix landing on
 * one of them kept missing the other (#355).
 */

/**
 * How many stat-and-remove pairs the sweep runs at once.
 *
 * `Promise.all` over the doomed list used to start every pair at the same time.
 * One measured run evicted 1,664 entries, which meant 1,664 concurrent file
 * handles at startup, on the same disk the launcher is reading a config and a
 * window from (#354). The work is short and IO bound, so a handful in flight
 * keeps the disk busy without the burst; nothing waits on this sweep, it is
 * fire and forget after the window exists.
 */
export const CACHE_SWEEP_CONCURRENCY_LIMIT = 8

/**
 * Shared by both caches rather than one each: what needs bounding is how much
 * filesystem work the startup does at once, and the two sweeps run at the same
 * moment on the same disk.
 */
const sweepConcurrency = new ConcurrencyLimiter(CACHE_SWEEP_CONCURRENCY_LIMIT)

/** One file the sweep found in a cache folder. */
export interface CacheSweepEntry {
  /** File name inside the cache folder, never a path. */
  name: string
  /** Size on disk. */
  bytes: number
  /** The timestamp this cache evicts by, and re-reads before deleting. */
  recencyMs: number
}

export interface CacheSweepSpec {
  /** Folder to sweep. A missing folder is an ordinary first-run state. */
  folder: string
  /** Log prefix, up to and including the calling function's own name. */
  origin: string
  /** How the folder is named in a log line, for example `the icon cache`. */
  subject: string
  /**
   * Whether this name is one the cache owns. Called inside the per-file guard,
   * so a check that throws its own reason (rather than returning false) reads as
   * a refusal too, and gets logged with that reason.
   */
  accepts(name: string): boolean
  /** Which of the file's timestamps is this cache's recency signal. */
  recencyOf(stats: fse.Stats): number
  /** The cache's own eviction order. Returns the names to remove. */
  plan(entries: readonly CacheSweepEntry[]): string[]
}

/**
 * Best effort throughout: both callers run this at startup, and a cache sweep
 * must never be able to break a launch, so every filesystem error is logged and
 * swallowed.
 *
 * @param spec What tells this cache apart from the other one.
 * @returns Nothing. The outcome is in the log.
 */
export async function sweepCacheFolder(spec: CacheSweepSpec): Promise<void> {
  let names: string[]
  try {
    names = await fse.readdir(spec.folder)
  } catch {
    // No cache folder yet, or it just vanished: nothing to sweep either way.
    return
  }

  const entries: CacheSweepEntry[] = []
  for (const name of names) {
    try {
      if (!spec.accepts(name)) continue
      const stats = await fse.stat(join(spec.folder, name))
      if (stats.isFile()) entries.push({ name, bytes: stats.size, recencyMs: spec.recencyOf(stats) })
    } catch (err) {
      logMessage("debug", `${spec.origin} Skipping ${name}: ${err}`)
    }
  }

  const doomed = spec.plan(entries)
  if (doomed.length === 0) return

  const recencyByName = new Map(entries.map((entry) => [entry.name, entry.recencyMs]))
  const bytesByName = new Map(entries.map((entry) => [entry.name, entry.bytes]))
  let reclaimed = 0

  await Promise.all(
    doomed.map((name) =>
      sweepConcurrency.run(async () => {
        try {
          // Re-stat before removal: if the timestamp moved since the snapshot, a
          // concurrent write just recreated this entry. Skip it.
          const current = await fse.stat(join(spec.folder, name))
          if (spec.recencyOf(current) !== recencyByName.get(name)) return

          await fse.remove(join(spec.folder, name))
          reclaimed += bytesByName.get(name) ?? 0
        } catch (err) {
          logMessage("debug", `${spec.origin} Could not remove ${name} from ${spec.subject}: ${err}`)
        }
      })
    )
  )

  logMessage("info", `${spec.origin} Removed ${doomed.length} entries from ${spec.subject}, ${reclaimed} bytes reclaimed.`)
}
