import { app } from "electron"
import { Worker } from "worker_threads"

import { WorkerPool } from "@src/ipc/workerPool"
import type { WorkerLease } from "@src/ipc/workerPool"

export type { WorkerDisposition, WorkerLease } from "@src/ipc/workerPool"

/**
 * How long an unused worker waits for the next task of its kind before its thread is
 * terminated.
 *
 * The reuse this exists for happens in milliseconds, not minutes: the ConcurrencyLimiter
 * hands its queued task to a just-freed slot immediately, and extracting a mod follows
 * downloading it right away. What 30 seconds buys on top of that is the gap a person takes
 * between clicking install on one mod and the next. Past that, the odds of a follow-up task
 * fall off while the resident cost of the idle isolate does not.
 */
const IDLE_WORKER_TIMEOUT_MS = 30_000

/**
 * A worker is retired after this many tasks even while it is still being reused. Not a
 * tuning knob, a bound on any per-task leak inside one isolate, so a launcher left open for
 * a week can't grow one worker's heap without limit.
 */
const MAX_TASKS_PER_WORKER = 50

const pool = new WorkerPool((scriptPath) => new Worker(scriptPath), {
  idleTimeoutMs: IDLE_WORKER_TIMEOUT_MS,
  maxTasksPerWorker: MAX_TASKS_PER_WORKER
})

/**
 * Takes a worker for one task. Release the lease once the task settles, saying whether the
 * worker may serve another one.
 */
export function acquireWorker(scriptPath: string, maxIdle: number): WorkerLease {
  return pool.acquire(scriptPath, maxIdle)
}

export function terminateActiveWorkers(): void {
  pool.terminateAll()
}

app.on("before-quit", terminateActiveWorkers)
