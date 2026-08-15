import { app } from "electron"
import { Worker } from "worker_threads"

const activeWorkers = new Set<Worker>()

export function createTrackedWorker(filePath: string, workerData: object): Worker {
  const worker = new Worker(filePath, { workerData })
  activeWorkers.add(worker)

  worker.once("exit", () => {
    activeWorkers.delete(worker)
  })

  return worker
}

export function disposeTrackedWorker(worker: Worker): void {
  activeWorkers.delete(worker)
  void worker.terminate()
}

export function terminateActiveWorkers(): void {
  for (const worker of activeWorkers) {
    activeWorkers.delete(worker)
    void worker.terminate()
  }
}

app.on("before-quit", terminateActiveWorkers)
