import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
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

  it("hands the thrown error to describeFailure, so a worker can forward its own message", async () => {
    // compressWorker and extractWorker both pass (error) => error.message here.
    // If serveTasks stopped handing the error over, every distinct compression
    // failure would collapse back to one string (#337).
    const { serveTasks } = await import("@src/ipc/workers/workerHost")
    serveTasks(
      async () => {
        throw new Error("Compression source is too large")
      },
      (error) => (error instanceof Error ? error.message : "Compression failed")
    )

    port.emit("message", { type: "task", token: 1, payload: {} })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))
    assert.deepEqual(lastMessage(), { type: "error", token: 1, message: "Compression source is too large" })
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

/**
 * Issue #358. The describer compressWorker ships is written inline in its
 * `serveTasks` call and nothing else imports it, so every test above passes one
 * of its own and collapsing the shipped one back to a constant went unnoticed.
 * The worker module is imported for real here, over the same fake port, and the
 * failures are the ones the filesystem actually raises: a missing folder and a
 * source that is a file. Both take the route a full disk (ENOSPC) or a denied
 * write (EACCES) takes, which is the case #337 was reported for.
 */
describe("the compress worker's own failure describer", () => {
  it("forwards each distinct compression failure instead of one constant sentence", async () => {
    // Imported after beforeEach has put the fake port in place: serveTasks reads
    // parentPort when the module body runs.
    await import("@src/ipc/workers/compressWorker")

    const missingSource = { inputPath: "/nonexistent-riftlauncher-backup-source", outputPath: "/tmp", outputFileName: "backup.tar.gz" }
    port.emit("message", { type: "task", token: 1, payload: missingSource })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))

    const missingSourceMessage = (lastMessage() as { message: string }).message
    assert.match(missingSourceMessage, /ENOENT/, `expected the filesystem's own reason, got: ${missingSourceMessage}`)
    assert.notEqual(missingSourceMessage, "Compression failed")

    port.postMessage.mockClear()
    // A file rather than a folder: a different throw in compression.ts, and it
    // has to arrive as a different sentence.
    const fileAsSource = { inputPath: fileURLToPath(import.meta.url), outputPath: "/tmp", outputFileName: "backup.tar.gz" }
    port.emit("message", { type: "task", token: 2, payload: fileAsSource })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))

    const fileAsSourceMessage = (lastMessage() as { message: string }).message
    assert.equal(fileAsSourceMessage, "Compression source must be a directory")
    assert.notEqual(fileAsSourceMessage, missingSourceMessage)
  })
})

/**
 * Issue #527. Same defect as #358 above, in the Inno worker instead of the compress one:
 * its describer was the fixed constant `() => "Installer payload extraction failed"`, so
 * every extraction failure logged the exact same sentence regardless of cause. Imported for
 * real over the same fake port, and the failure is the one the filesystem actually raises
 * for a missing installer (`open`'s own ENOENT), the shape the linked player report was in.
 */
describe("the inno extract worker's own failure describer", () => {
  it("forwards the real extraction failure instead of the fixed sentence", async () => {
    await import("@src/ipc/workers/innoExtractWorker")

    const missingInstaller = { filePath: "/nonexistent-riftlauncher-installer.exe", outputPath: "/tmp", deleteInstaller: false }
    port.emit("message", { type: "task", token: 1, payload: missingInstaller })
    await vi.waitFor(() => assert.equal(lastMessage() !== undefined, true))

    const message = (lastMessage() as { message: string }).message
    assert.match(message, /ENOENT/, `expected the filesystem's own reason, got: ${message}`)
    assert.notEqual(message, "Installer payload extraction failed")

    // #528: cleanupWarning is the only hop that carries a best-effort cleanup failure
    // from runInnoExtraction's outcome to the finished message this worker posts back.
    // Nothing else in the suite runs the worker itself far enough to set it.
    const workspace = mkdtempSync(join(tmpdir(), "rift-worker-host-test-"))
    try {
      const installer = join(workspace, "valid.bin")
      copyFileSync(join(__dirname, "../fixtures/inno/valid.bin"), installer)

      const fse = (await import("fs-extra")).default
      vi.spyOn(fse, "unlinkSync").mockImplementation(() => {
        throw Object.assign(new Error("EBUSY: resource busy or locked, unlink"), { code: "EBUSY" })
      })

      port.postMessage.mockClear()
      port.emit("message", { type: "task", token: 2, payload: { filePath: installer, outputPath: join(workspace, "target"), deleteInstaller: true } })
      await vi.waitFor(() => assert.equal((lastMessage() as { type?: string } | undefined)?.type, "finished"))

      assert.equal((lastMessage() as { cleanupWarning?: string }).cleanupWarning, "installer-cleanup-failed")
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
