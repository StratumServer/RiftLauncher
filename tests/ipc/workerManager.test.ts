import assert from "node:assert/strict"
import { describe, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  options: undefined as { onCancelGraceExpired?: (scriptPath: string) => void } | undefined,
  logMessage: vi.fn(),
  beforeQuit: undefined as (() => void) | undefined,
  vetoed: false,
  terminateAll: vi.fn(() => null)
}))

vi.mock("electron", () => ({
  app: {
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "before-quit") mocks.beforeQuit = listener
    })
  }
}))
vi.mock("node:worker_threads", () => ({ Worker: vi.fn() }))
vi.mock("@src/utils/logManager", () => ({ logMessage: mocks.logMessage }))
vi.mock("@src/utils/shouldPreventClose", () => ({ isQuitGoingToBeVetoed: (): boolean => mocks.vetoed }))
vi.mock("@src/ipc/workerPool", () => ({
  WorkerPool: vi.fn(function (this: { terminateAll: unknown }, _factory: unknown, options: typeof mocks.options) {
    mocks.options = options
    this.terminateAll = mocks.terminateAll
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

  it("leaves the workers running on a quit a close guard is going to veto, and ends them on any other (#758)", async () => {
    await import("@src/ipc/workerManager")
    assert.ok(mocks.beforeQuit)

    mocks.vetoed = true
    mocks.beforeQuit()
    assert.equal(mocks.terminateAll.mock.calls.length, 0)

    mocks.vetoed = false
    mocks.beforeQuit()
    assert.equal(mocks.terminateAll.mock.calls.length, 1)
  })
})
