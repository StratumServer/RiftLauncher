import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { ConcurrencyLimiter } from "@src/ipc/concurrencyLimiter"

/** A task that only resolves once `release()` is called, so a test controls exactly when it finishes. */
function deferredTask(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise
  })
  return { promise, release }
}

describe("ConcurrencyLimiter", () => {
  it("runs a task immediately when under the limit", async () => {
    const limiter = new ConcurrencyLimiter(2)
    const result = await limiter.run(async () => "done")
    assert.equal(result, "done")
  })

  it("runs up to `limit` tasks concurrently without queuing any of them", async () => {
    const limiter = new ConcurrencyLimiter(2)
    const first = deferredTask()
    const second = deferredTask()

    void limiter.run(() => first.promise)
    void limiter.run(() => second.promise)
    // Both tasks got to start: the limiter never held either one back.
    await Promise.resolve()

    assert.equal(limiter.activeCount, 2)
    assert.equal(limiter.queuedCount, 0)

    first.release()
    second.release()
  })

  it("queues a task past the limit and starts it only once a slot frees", async () => {
    const limiter = new ConcurrencyLimiter(1)
    const first = deferredTask()
    const started: string[] = []

    void limiter.run(async () => {
      started.push("first")
      return first.promise
    })
    await Promise.resolve()

    const thirdRun = limiter.run(async () => {
      started.push("second")
    })
    await Promise.resolve()

    // The second task is queued, not started: the limiter is already at its cap of 1.
    assert.deepEqual(started, ["first"])
    assert.equal(limiter.activeCount, 1)
    assert.equal(limiter.queuedCount, 1)

    first.release()
    await thirdRun

    assert.deepEqual(started, ["first", "second"])
    assert.equal(limiter.activeCount, 0)
    assert.equal(limiter.queuedCount, 0)
  })

  it("releases the slot even when the task throws", async () => {
    const limiter = new ConcurrencyLimiter(1)

    await assert.rejects(() =>
      limiter.run(async () => {
        throw new Error("boom")
      })
    )

    assert.equal(limiter.activeCount, 0)
    // A slot that a throw failed to release would hang this forever, since limit is 1.
    const result = await limiter.run(async () => "recovered")
    assert.equal(result, "recovered")
  })

  it("runs queued tasks in FIFO order", async () => {
    const limiter = new ConcurrencyLimiter(1)
    const first = deferredTask()
    const order: string[] = []

    void limiter.run(() => first.promise)
    await Promise.resolve()

    const second = limiter.run(async () => {
      order.push("second")
    })
    const third = limiter.run(async () => {
      order.push("third")
    })

    first.release()
    await Promise.all([second, third])

    assert.deepEqual(order, ["second", "third"])
  })
})
