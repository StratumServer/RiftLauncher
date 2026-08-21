import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import { WorkerPool } from "../../src/ipc/workerPool"

type FakeWorker = EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; ref: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }

/**
 * A fake worker_threads.Worker: a real EventEmitter (so "error"/"exit" listeners behave
 * exactly like the real thing) plus the handful of methods WorkerPool calls on one. Typed
 * as `Worker` at the boundary so `WorkerPool` never sees the difference; `asFake` below
 * gets the rich shape back for assertions.
 */
function fakeWorker(): Worker {
  const worker = new EventEmitter()
  return Object.assign(worker, {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => 0),
    ref: vi.fn(),
    unref: vi.fn()
  }) as unknown as Worker
}

function asFake(worker: Worker): FakeWorker {
  return worker as unknown as FakeWorker
}

describe("WorkerPool", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("hands out a different worker to each of two acquisitions before any release", () => {
    const factory = vi.fn(() => fakeWorker())
    const pool = new WorkerPool(factory)

    const first = pool.acquire("script.js", 2)
    const second = pool.acquire("script.js", 2)

    assert.notEqual(first.worker, second.worker)
    assert.equal(factory.mock.calls.length, 2)
  })

  it("reuses a released worker instead of spawning a new one", () => {
    const factory = vi.fn(() => fakeWorker())
    const pool = new WorkerPool(factory)

    const lease = pool.acquire("script.js", 2)
    lease.release("reuse")
    const nextLease = pool.acquire("script.js", 2)

    assert.equal(nextLease.worker, lease.worker)
    assert.equal(factory.mock.calls.length, 1)
  })

  it("terminates a discarded worker and spawns fresh on the next acquire", () => {
    const factory = vi.fn(() => fakeWorker())
    const pool = new WorkerPool(factory)

    const lease = pool.acquire("script.js", 2)
    lease.release("discard")
    assert.equal(asFake(lease.worker).terminate.mock.calls.length, 1)

    const nextLease = pool.acquire("script.js", 2)
    assert.notEqual(nextLease.worker, lease.worker)
    assert.equal(factory.mock.calls.length, 2)
  })

  it("terminates the worker over the idle cap instead of growing the idle list past maxIdle", () => {
    const pool = new WorkerPool(() => fakeWorker())

    const leaseA = pool.acquire("script.js", 2)
    const leaseB = pool.acquire("script.js", 2)
    const leaseC = pool.acquire("script.js", 2)

    leaseA.release("reuse")
    leaseB.release("reuse")
    // The cap is checked against the worker being released, not by evicting an older idle
    // one to make room: A and B already fit, so C is the one turned away.
    leaseC.release("reuse")

    assert.equal(pool.idleWorkerCount, 2)
    assert.equal(asFake(leaseC.worker).terminate.mock.calls.length, 1)
    assert.equal(asFake(leaseA.worker).terminate.mock.calls.length, 0)
    assert.equal(asFake(leaseB.worker).terminate.mock.calls.length, 0)
  })

  it("terminates on every release when maxIdle is 0", () => {
    const pool = new WorkerPool(() => fakeWorker())

    const lease = pool.acquire("script.js", 0)
    lease.release("reuse")

    assert.equal(pool.idleWorkerCount, 0)
    assert.equal(asFake(lease.worker).terminate.mock.calls.length, 1)
  })

  it("terminates an idle worker once its idle timeout elapses", () => {
    const pool = new WorkerPool(() => fakeWorker(), { idleTimeoutMs: 30_000 })

    const lease = pool.acquire("script.js", 2)
    lease.release("reuse")
    assert.equal(pool.idleWorkerCount, 1)

    vi.advanceTimersByTime(30_000)

    assert.equal(pool.idleWorkerCount, 0)
    assert.equal(asFake(lease.worker).terminate.mock.calls.length, 1)
  })

  it("cancels the idle timer on reuse, so a later timer tick from the old deadline never fires", () => {
    const factory = vi.fn(() => fakeWorker())
    const pool = new WorkerPool(factory, { idleTimeoutMs: 30_000 })

    const lease = pool.acquire("script.js", 2)
    lease.release("reuse")

    vi.advanceTimersByTime(29_000)
    const reused = pool.acquire("script.js", 2)
    vi.advanceTimersByTime(30_000)

    assert.equal(asFake(reused.worker).terminate.mock.calls.length, 0)
    assert.equal(factory.mock.calls.length, 1)
  })

  it("evicts a worker that exits while idle, so the next acquire spawns fresh instead of handing out a dead thread", () => {
    const factory = vi.fn(() => fakeWorker())
    const pool = new WorkerPool(factory)

    const lease = pool.acquire("script.js", 2)
    lease.release("reuse")
    assert.equal(pool.idleWorkerCount, 1)

    lease.worker.emit("exit", 1)
    assert.equal(pool.idleWorkerCount, 0)

    const nextLease = pool.acquire("script.js", 2)
    assert.notEqual(nextLease.worker, lease.worker)
    assert.equal(factory.mock.calls.length, 2)
  })

  it("evicts a worker that errors while idle without throwing out of the pool", () => {
    const pool = new WorkerPool(() => fakeWorker())

    const lease = pool.acquire("script.js", 2)
    lease.release("reuse")

    assert.doesNotThrow(() => lease.worker.emit("error", new Error("boom")))
    assert.equal(pool.idleWorkerCount, 0)
  })

  it("does not add a worker that died mid-task to the idle list on release", () => {
    const pool = new WorkerPool(() => fakeWorker())

    const lease = pool.acquire("script.js", 2)
    lease.worker.emit("exit", 1)
    lease.release("reuse")

    assert.equal(pool.idleWorkerCount, 0)
  })

  it("release is idempotent: a second call does nothing", () => {
    const pool = new WorkerPool(() => fakeWorker())

    const lease = pool.acquire("script.js", 2)
    lease.release("reuse")
    lease.release("discard")

    // The discard never took effect: the first release (reuse) already won.
    assert.equal(pool.idleWorkerCount, 1)
    assert.equal(asFake(lease.worker).terminate.mock.calls.length, 0)
  })

  it("refuses to spawn a fresh worker on acquire after terminateAll, instead of resurrecting the pool", () => {
    const factory = vi.fn(() => fakeWorker())
    const pool = new WorkerPool(factory)

    pool.acquire("script.js", 2)
    pool.terminateAll()
    assert.equal(factory.mock.calls.length, 1)

    assert.throws(() => pool.acquire("script.js", 2))
    // The pool never asked the factory for a second worker: acquire() refused before spawn().
    assert.equal(factory.mock.calls.length, 1)
  })

  it("terminateAll kills idle and busy workers alike, and a later release cannot resurrect one", () => {
    const pool = new WorkerPool(() => fakeWorker())

    const idleLease = pool.acquire("script.js", 2)
    const busyLease = pool.acquire("script.js", 2)
    assert.notEqual(idleLease.worker, busyLease.worker)
    idleLease.release("reuse")

    pool.terminateAll()

    assert.equal(asFake(idleLease.worker).terminate.mock.calls.length, 1)
    assert.equal(asFake(busyLease.worker).terminate.mock.calls.length, 1)
    assert.equal(pool.liveWorkerCount, 0)

    busyLease.release("reuse")
    assert.equal(pool.idleWorkerCount, 0)
  })

  it("retires a worker after maxTasksPerWorker releases, even when each one asks for reuse", () => {
    const factory = vi.fn(() => fakeWorker())
    const pool = new WorkerPool(factory, { maxTasksPerWorker: 2 })

    let lease = pool.acquire("script.js", 5)
    lease.release("reuse")
    lease = pool.acquire("script.js", 5)
    assert.equal(factory.mock.calls.length, 1)
    lease.release("reuse")

    assert.equal(pool.idleWorkerCount, 0)
    assert.equal(asFake(lease.worker).terminate.mock.calls.length, 1)
  })

  it("dispatch posts a task message carrying the lease's own token, and tokens are unique per acquire", () => {
    const pool = new WorkerPool(() => fakeWorker())

    const leaseA = pool.acquire("script.js", 2)
    leaseA.dispatch({ hello: "a" })
    leaseA.release("discard")
    const leaseB = pool.acquire("script.js", 2)
    leaseB.dispatch({ hello: "b" })

    assert.notEqual(leaseA.token, leaseB.token)
    assert.deepEqual(asFake(leaseA.worker).postMessage.mock.calls[0]?.[0], { type: "task", token: leaseA.token, payload: { hello: "a" } })
    assert.deepEqual(asFake(leaseB.worker).postMessage.mock.calls[0]?.[0], { type: "task", token: leaseB.token, payload: { hello: "b" } })
  })

  it("keeps separate idle pools per script path", () => {
    const pool = new WorkerPool(() => fakeWorker())

    const downloadLease = pool.acquire("downloadWorker.js", 2)
    downloadLease.release("reuse")

    const extractLease = pool.acquire("extractWorker.js", 2)
    assert.notEqual(extractLease.worker, downloadLease.worker)
    assert.equal(pool.idleWorkerCount, 1)
  })
})
