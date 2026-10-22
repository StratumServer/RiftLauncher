import assert from "node:assert/strict"
import { beforeEach, describe, it, vi } from "vitest"

import type { TaskHandler } from "@src/ipc/workers/workerHost"

/**
 * The shim between the Inno worker host and runInnoExtraction.
 *
 * What crosses it is the cancel signal (#758): serveTasks aborts it when the pool asks the
 * running task to stop, and runInnoExtraction only unwinds through its cleanup, which lets the
 * native stream go, if the signal reaches it. Drop the argument here and everything still
 * compiles and passes, but a timeout or quit just waits out the pool's grace period and ends
 * the thread mid-stream.
 *
 * workerHost is mocked because importing the shim is what runs serveTasks, and serveTasks
 * throws outside a worker thread.
 */
const { serveTasks, runInnoExtraction } = vi.hoisted(() => ({ serveTasks: vi.fn(), runInnoExtraction: vi.fn() }))

vi.mock("@src/ipc/workers/workerHost", () => ({ serveTasks }))
vi.mock("@src/ipc/workers/innoExtraction", () => ({ runInnoExtraction }))

async function innoTaskHandler(): Promise<TaskHandler> {
  vi.resetModules()
  serveTasks.mockClear()
  runInnoExtraction.mockClear()
  await import("@src/ipc/workers/innoExtractWorker")
  return serveTasks.mock.calls[0]?.[0] as TaskHandler
}

const PAYLOAD = { filePath: "/versions/setup.exe", outputPath: "/versions/1.22.6", deleteInstaller: true }

beforeEach(() => {
  runInnoExtraction.mockResolvedValue({ verdict: "extracted", filesWritten: 3, bytesWritten: 30 })
})

describe("innoExtractWorker", () => {
  it("forwards the host's cancel signal to the extraction, the same object", async () => {
    const handle = await innoTaskHandler()
    const controller = new AbortController()

    await handle(PAYLOAD, () => {}, controller.signal)

    assert.equal(runInnoExtraction.mock.calls[0]?.[0].signal, controller.signal)
  })

  it("passes an abort that happens during the extraction through to the same signal", async () => {
    const handle = await innoTaskHandler()
    const controller = new AbortController()
    runInnoExtraction.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      controller.abort()
      assert.equal(signal.aborted, true)
      return { verdict: "extracted", filesWritten: 0, bytesWritten: 0 }
    })

    await handle(PAYLOAD, () => {}, controller.signal)

    assert.equal(runInnoExtraction.mock.calls.length, 1)
  })

  it("passes the rest of the payload and the progress callback on under the names runInnoExtraction uses", async () => {
    const handle = await innoTaskHandler()
    const onProgress = (): void => {}

    await handle(PAYLOAD, onProgress, new AbortController().signal)

    const call = runInnoExtraction.mock.calls[0]?.[0]
    assert.equal(call.filePath, PAYLOAD.filePath)
    assert.equal(call.outputPath, PAYLOAD.outputPath)
    assert.equal(call.deleteInstaller, true)
    assert.equal(call.onProgress, onProgress)
  })

  it("reports the outcome fields the main process reads", async () => {
    const handle = await innoTaskHandler()

    const result = await handle(PAYLOAD, () => {}, new AbortController().signal)

    assert.deepEqual(result, { verdict: "extracted", reason: undefined, filesWritten: 3, bytesWritten: 30, cleanupWarning: undefined })
  })

  it("lets an extraction failure reject so the host reports it", async () => {
    const handle = await innoTaskHandler()
    runInnoExtraction.mockRejectedValueOnce(new Error("digest mismatch"))

    await assert.rejects(() => Promise.resolve(handle(PAYLOAD, () => {}, new AbortController().signal)), /digest mismatch/)
  })

  it("maps errors to their message and anything else to a generic one", async () => {
    await innoTaskHandler()
    const describeError = serveTasks.mock.calls[0]?.[1] as (error: unknown) => string

    assert.equal(describeError(new Error("boom")), "boom")
    assert.equal(describeError("not an error"), "Installer payload extraction failed")
  })
})
