import { ConcurrencyLimiter } from "../concurrencyLimiter"

/**
 * How many renames or deletes one batch keeps in flight. Each is a single metadata call, so this is
 * not about disk load: it keeps a batch over a few hundred Mods from queueing a few hundred IPC calls
 * at once, while still not paying every round trip in series.
 */
export const MOD_BATCH_CONCURRENCY = 4

/** The two host calls a batch is made of, both already validated item by item at the boundary. */
export interface ModBatchPorts {
  setEnabled(path: string, enabled: boolean): Promise<SetModEnabledResult>
  remove(path: string): Promise<boolean>
}

/** Why one item of a batch left its archive as it was. Fixed tokens, safe to count and log. */
export type ModBatchFailure = "name-taken" | "refused"

/** One item's outcome, keyed by the path the caller handed in. */
export type ModBatchResult = { path: string; ok: true } | { path: string; ok: false; reason: ModBatchFailure }

/**
 * Runs one item through the limiter and settles it on its own: a rejected call is that item's
 * refusal, never the batch's, so one locked file does not stop the rest.
 */
async function settle(limiter: ConcurrencyLimiter, path: string, task: () => Promise<ModBatchResult>): Promise<ModBatchResult> {
  try {
    return await limiter.run(task)
  } catch {
    return { path, ok: false, reason: "refused" }
  }
}

/**
 * Turns each archive on or off as asked, and reports every one, in the order given.
 *
 * Takes a target state per item, so a switch that turns some Mods on and others off is one call.
 * An archive the host finds already in the wanted state counts as done: it is how the player asked
 * for it to be. Nothing is rolled back; the successes stay.
 */
export function setModsEnabled(ports: ModBatchPorts, changes: readonly { path: string; enabled: boolean }[]): Promise<ModBatchResult[]> {
  const limiter = new ConcurrencyLimiter(MOD_BATCH_CONCURRENCY)
  return Promise.all(
    changes.map(({ path, enabled }) =>
      settle(limiter, path, async () => {
        const result = await ports.setEnabled(path, enabled)
        if (result.ok || result.reason === "already-in-state") return { path, ok: true }
        return { path, ok: false, reason: result.reason }
      })
    )
  )
}

/** Deletes each archive, and reports every one, in the order given. A `false` answer is a refusal. */
export function removeMods(ports: ModBatchPorts, paths: readonly string[]): Promise<ModBatchResult[]> {
  const limiter = new ConcurrencyLimiter(MOD_BATCH_CONCURRENCY)
  return Promise.all(paths.map((path) => settle(limiter, path, async () => ((await ports.remove(path)) ? { path, ok: true } : { path, ok: false, reason: "refused" }))))
}
