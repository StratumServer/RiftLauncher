import { app } from "electron"
import { Worker } from "node:worker_threads"

import { WorkerPool } from "@src/ipc/workerPool"
import { logMessage } from "@src/utils/logManager"
import type { AcquireOptions, WorkerLease } from "@src/ipc/workerPool"

export type { WorkerDisposition, WorkerLease } from "@src/ipc/workerPool"

const pool = new WorkerPool((scriptPath) => new Worker(scriptPath), {
  onCancelGraceExpired: (): void => logMessage("warn", `[back] [ipc/workerManager.ts] A cancelled worker did not confirm in time and was terminated mid-task.`)
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
 */
export function terminateActiveWorkers(): Promise<void> | null {
  return pool.terminateAll()
}

app.on("before-quit", () => {
  void terminateActiveWorkers()
})
