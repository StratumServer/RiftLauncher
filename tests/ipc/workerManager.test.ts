import assert from "node:assert/strict"
import { describe, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  options: undefined as { onCancelGraceExpired?: (scriptPath: string) => void } | undefined,
  logMessage: vi.fn()
}))

vi.mock("electron", () => ({ app: { on: vi.fn() } }))
vi.mock("node:worker_threads", () => ({ Worker: vi.fn() }))
vi.mock("@src/utils/logManager", () => ({ logMessage: mocks.logMessage }))
vi.mock("@src/ipc/workerPool", () => ({
  WorkerPool: vi.fn(function (_factory: unknown, options: typeof mocks.options) {
    mocks.options = options
  })
}))

describe("workerManager", () => {
  it("logs a warning when a cancelled worker is terminated without having confirmed (#758)", async () => {
    await import("@src/ipc/workerManager")

    assert.ok(mocks.options?.onCancelGraceExpired)
    mocks.options.onCancelGraceExpired("inno.js")

    assert.equal(mocks.logMessage.mock.calls.length, 1)
    assert.equal(mocks.logMessage.mock.calls[0]![0], "warn")
    assert.match(String(mocks.logMessage.mock.calls[0]![1]), /did not confirm in time/)
    // Same three-part tag as every other main-process line: area, then the file the line is in.
    // The pool has no logger of its own on purpose (it would have to import Electron), so the
    // one line it can never write is this one, and a line without the tag is unsourceable.
    assert.match(String(mocks.logMessage.mock.calls[0]![1]), /^\[back\] \[ipc\] \[ipc\/workerManager\.ts\] /)
  })
})
