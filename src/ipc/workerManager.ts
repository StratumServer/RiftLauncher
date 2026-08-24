import { app } from "electron"
import { Worker } from "node:worker_threads"

import { WorkerPool } from "@src/ipc/workerPool"
import type { WorkerLease } from "@src/ipc/workerPool"

export type { WorkerDisposition, WorkerLease } from "@src/ipc/workerPool"

const pool = new WorkerPool((scriptPath) => new Worker(scriptPath))

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
