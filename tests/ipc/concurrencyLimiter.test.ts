import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { ConcurrencyLimiter, LIMITER_SHUTDOWN_MESSAGE } from "@src/ipc/concurrencyLimiter"

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

  it("rejects a task still queued when shutdown runs, and never starts it", async () => {
    const limiter = new ConcurrencyLimiter(1)
    const first = deferredTask()
    const started: string[] = []

    void limiter.run(() => first.promise)
    await Promise.resolve()

    const queued = limiter.run(async () => {
      started.push("queued")
    })
    await Promise.resolve()
    assert.equal(limiter.queuedCount, 1)

    limiter.shutdown()
    await assert.rejects(queued, new RegExp(LIMITER_SHUTDOWN_MESSAGE))

    first.release()
    await first.promise
    // The freed slot never reached the queued task: shutdown removed it from the line.
    assert.deepEqual(started, [])
    assert.equal(limiter.queuedCount, 0)
  })

  it("rejects a task that arrives after shutdown without ever queuing or running it", async () => {
    const limiter = new ConcurrencyLimiter(1)

    limiter.shutdown()

    await assert.rejects(() => limiter.run(async () => "should never run"), new RegExp(LIMITER_SHUTDOWN_MESSAGE))
    assert.equal(limiter.activeCount, 0)
    assert.equal(limiter.queuedCount, 0)
  })

  it("rejects a task even when shutdown lands after acquire resolves but before the task body runs", async () => {
    const limiter = new ConcurrencyLimiter(1)
    let ran = false

    // run() awaits acquire() first, so shutdown() called synchronously right after has a real
    // chance to land in the gap between that resolution and the re-check at the top of the
    // try block, exactly the race the re-check exists to close.
    const result = limiter.run(async () => {
      ran = true
    })
    limiter.shutdown()

    await assert.rejects(result, new RegExp(LIMITER_SHUTDOWN_MESSAGE))
    assert.equal(ran, false)
  })

  it("treats a second shutdown call as a no-op", async () => {
    const limiter = new ConcurrencyLimiter(1)
    const first = deferredTask()

    void limiter.run(() => first.promise)
    await Promise.resolve()
    const queued = limiter.run(async () => "queued")
    await Promise.resolve()

    limiter.shutdown()
    assert.doesNotThrow(() => limiter.shutdown())

    await assert.rejects(queued, new RegExp(LIMITER_SHUTDOWN_MESSAGE))
    assert.equal(limiter.isShuttingDown, true)

    first.release()
    await first.promise
  })
})
