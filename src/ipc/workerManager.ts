import { app } from "electron"
import { Worker } from "node:worker_threads"

import { WorkerPool } from "@src/ipc/workerPool"
import { logMessage } from "@src/utils/logManager"
import { isQuitGoingToBeVetoed } from "@src/utils/shouldPreventClose"
import type { AcquireOptions, WorkerLease } from "@src/ipc/workerPool"

export type { WorkerDisposition, WorkerLease } from "@src/ipc/workerPool"

const LOG_PREFIX = "[back] [ipc] [ipc/workerManager.ts]"

const pool = new WorkerPool((scriptPath) => new Worker(scriptPath), {
  onCancelGraceExpired: (): void => logMessage("warn", `${LOG_PREFIX} A cancelled worker did not confirm in time and was terminated mid-task.`)
})

/**
 * Takes a worker for one task. Release the lease once the task settles, saying whether the
 * worker may serve another one.
 */
export function acquireWorker(scriptPath: string, maxIdle: number, options?: AcquireOptions): WorkerLease {
  return pool.acquire(scriptPath, maxIdle, options)
}

/**
 * Ends every worker. Workers that cannot be told to stop their task are terminated before this
 * returns; the promise, null when there is none, settles once the ones that can have stopped
 * (#758) have, or ran out of grace.
 *
 * A worker that is already cancelling is waited on, not terminated: this is the second call on
 * quit, because this module registers its handler before main/index.ts registers its own, and
 * ending the thread under the native read is the #758 crash.
 */
export function terminateActiveWorkers(): Promise<void> | null {
  return pool.terminateAll()
}

// A quit a close guard is going to veto (#702) must leave the workers alone: terminateAll ends
// the running task and shuts the pool for the rest of the session (#758).
app.on("before-quit", () => {
  if (isQuitGoingToBeVetoed()) return
  void terminateActiveWorkers()
})
