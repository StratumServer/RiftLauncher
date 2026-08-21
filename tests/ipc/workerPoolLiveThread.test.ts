import assert from "node:assert/strict"
import { Worker } from "node:worker_threads"
import { describe, it } from "vitest"

/**
 * Everything else about worker pooling is proven against mocks (workerPool.test.ts,
 * workerHost.test.ts): a fake EventEmitter standing in for worker_threads.Worker. All of
 * that rests on one assumption neither mock can check: that a real worker thread with a
 * "message" listener attached actually stays alive and reachable after finishing a task,
 * instead of the thread exiting once its current work runs out (which is what the old
 * spawn-per-task design relied on, and which is exactly what a live MessagePort listener
 * is documented to prevent).
 *
 * No import of workerHost.ts here: a real OS thread only runs plain JS it's handed
 * directly, not this project's TypeScript path aliases. This checks the Node-level
 * guarantee workerHost.ts's design leans on, not workerHost.ts's own code.
 */
describe("a real worker thread outlives its first task", () => {
  it("stays alive to receive and answer a second task after finishing the first", async () => {
    const source = `
      const { parentPort } = require("worker_threads")
      parentPort.on("message", (msg) => {
        parentPort.postMessage({ type: "finished", token: msg.token, echo: msg.payload })
      })
    `
    const worker = new Worker(source, { eval: true })

    try {
      const nextMessage = (): Promise<unknown> => new Promise((resolvePromise) => worker.once("message", resolvePromise))

      worker.postMessage({ token: 1, payload: "first" })
      const first = await nextMessage()

      // If the worker had already exited after the first task, this postMessage would go
      // nowhere and the following await would hang until the test's own timeout: that
      // hang is exactly what would prove the assumption false.
      worker.postMessage({ token: 2, payload: "second" })
      const second = await nextMessage()

      assert.deepEqual(first, { type: "finished", token: 1, echo: "first" })
      assert.deepEqual(second, { type: "finished", token: 2, echo: "second" })
    } finally {
      await worker.terminate()
    }
  }, 10_000)
})
