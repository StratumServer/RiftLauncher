import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

vi.mock("worker_threads", () => ({ parentPort: null }))

/** A fake parentPort: a real EventEmitter, so serveTasks' own `.on("message", ...)` behaves like the real thing, plus a spy for what it posts back. */
function fakePort(): EventEmitter & { postMessage: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { postMessage: vi.fn() })
}

let port: ReturnType<typeof fakePort>

beforeEach(async () => {
  port = fakePort()
  const workerThreads = await import("worker_threads")
  // @ts-expect-error test seam: worker_threads is mocked above, so this module's exports
  // are a plain mutable object, not a real, read-only ESM namespace.
  workerThreads.parentPort = port
})

afterEach(() => {
  vi.restoreAllMocks()
})

function lastMessage(): unknown {
  return port.postMessage.mock.calls.at(-1)?.[0]
}

describe("serveTasks", () => {
  it("runs the handler for a task message and posts finished with the same token and the result merged in", async () => {
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    serveTasks(
      async () => ({ path: "/tmp/x.zip" }),
      () => "failed"
    )

    port.emit("message", { type: "task", token: 7, payload: {} })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))

    assert.deepEqual(lastMessage(), { path: "/tmp/x.zip", type: "finished", token: 7 })
  })

  it("drops a progress report emitted after its own task already settled", async () => {
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    let reportLate: (() => void) | undefined

    serveTasks(
      async (_payload, onProgress): Promise<Record<string, unknown>> => {
        onProgress(50)
        // Simulates node-7z/stream readers that can emit one more progress event after
        // their own end event, i.e. after this handler has already resolved.
        reportLate = (): void => onProgress(99)
        return {}
      },
      () => "failed"
    )

    port.emit("message", { type: "task", token: 1, payload: {} })
    await vi.waitFor(() =>
      assert.equal(
        port.postMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "finished"),
        true
      )
    )

    const callsBeforeLateReport = port.postMessage.mock.calls.length
    reportLate?.()

    assert.equal(port.postMessage.mock.calls.length, callsBeforeLateReport)
  })

  it("does not let a handler's result override the real type or token", async () => {
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    serveTasks(
      async () => ({ type: "hijacked", token: 999, path: "/tmp/x.zip" }),
      () => "failed"
    )

    port.emit("message", { type: "task", token: 7, payload: {} })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))

    assert.deepEqual(lastMessage(), { path: "/tmp/x.zip", type: "finished", token: 7 })
  })

  it("posts an error message using describeFailure, and stays able to serve a second task afterward", async () => {
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    serveTasks(
      async () => {
        throw new Error("network down")
      },
      () => "Download failed"
    )

    port.emit("message", { type: "task", token: 1, payload: {} })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))
    assert.deepEqual(lastMessage(), { type: "error", token: 1, message: "Download failed" })

    port.postMessage.mockClear()
    port.emit("message", { type: "task", token: 2, payload: {} })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))
    assert.deepEqual(lastMessage(), { type: "error", token: 2, message: "Download failed" })
  })

  it("posts an error, not an uncaught exception, when the handler throws synchronously", async () => {
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    serveTasks(
      () => {
        throw new Error("sync failure")
      },
      () => "Changing permissions failed"
    )

    assert.doesNotThrow(() => port.emit("message", { type: "task", token: 1, payload: {} }))
    assert.deepEqual(lastMessage(), { type: "error", token: 1, message: "Changing permissions failed" })
  })

  it("finishes a synchronous (non-Promise) handler result directly, the changePerms shape", async () => {
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    serveTasks(
      (): void => undefined,
      () => "failed"
    )

    port.emit("message", { type: "task", token: 1, payload: {} })

    assert.deepEqual(lastMessage(), { type: "finished", token: 1 })
  })

  it("echoes each task's own token across two tasks run in sequence", async () => {
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    serveTasks(
      async () => ({}),
      () => "failed"
    )

    port.emit("message", { type: "task", token: 11, payload: {} })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))
    assert.equal((lastMessage() as { token: number }).token, 11)

    port.postMessage.mockClear()
    port.emit("message", { type: "task", token: 12, payload: {} })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))
    assert.equal((lastMessage() as { token: number }).token, 12)
  })

  it("refuses a task that arrives while already busy, with retire, and lets the running task finish undisturbed", async () => {
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    let resolveFirst: (() => void) | undefined
    serveTasks(
      async () =>
        new Promise((resolvePromise) => {
          resolveFirst = (): void => resolvePromise({})
        }),
      () => "failed"
    )

    port.emit("message", { type: "task", token: 1, payload: {} })
    port.emit("message", { type: "task", token: 2, payload: {} })

    assert.deepEqual(lastMessage(), { type: "error", token: 2, message: "Worker received a task while busy", retire: true })

    resolveFirst?.()
    await vi.waitFor(() =>
      assert.equal(
        port.postMessage.mock.calls.some((call) => (call[0] as { token?: number }).token === 1),
        true
      )
    )
    const finishedForFirst = port.postMessage.mock.calls.find((call) => (call[0] as { token?: number }).token === 1)
    assert.equal((finishedForFirst?.[0] as { type?: string }).type, "finished")
  })

  it("ignores a message that is not a task message", async () => {
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    serveTasks(
      async () => ({}),
      () => "failed"
    )

    assert.doesNotThrow(() => port.emit("message", { type: "not-a-task" }))
    assert.doesNotThrow(() => port.emit("message", "just a string"))
    assert.doesNotThrow(() => port.emit("message", null))

    assert.equal(port.postMessage.mock.calls.length, 0)
  })
})
