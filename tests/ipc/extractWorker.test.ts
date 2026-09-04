import assert from "node:assert/strict"
import { beforeEach, describe, it, vi } from "vitest"

import type { TaskHandler } from "@src/ipc/workers/workerHost"

/**
 * The shim between the extraction handler and runExtraction.
 *
 * Worth its own file because of what crosses it: the main process decides
 * whether an archive is one of the launcher's own backups (#362), and this is
 * the only place that decision is carried into the worker. Drop the field
 * here and nothing else notices: every other suite still passes, and backups
 * over 2 GiB quietly refuse to restore again.
 *
 * workerHost is mocked because importing the shim is what runs serveTasks, and
 * serveTasks throws outside a worker thread. The mock hands back the task
 * handler it was given, which is the thing under test.
 */
const { serveTasks, runExtraction } = vi.hoisted(() => ({ serveTasks: vi.fn(), runExtraction: vi.fn() }))

vi.mock("@src/ipc/workers/workerHost", () => ({ serveTasks }))
vi.mock("@src/ipc/workers/extraction", () => ({ runExtraction }))

async function extractionTaskHandler(): Promise<TaskHandler> {
  vi.resetModules()
  serveTasks.mockClear()
  runExtraction.mockClear()
  await import("@src/ipc/workers/extractWorker")
  return serveTasks.mock.calls[0]?.[0] as TaskHandler
}

const PAYLOAD = { filePath: "/backups/Survival_2026-09-04.tar.gz", outputPath: "/installations/Survival", deleteZip: false, unwrapSingleRootFolder: false }

beforeEach(() => {
  runExtraction.mockResolvedValue(undefined)
})

describe("extractWorker", () => {
  it("carries the main process's backup decision through to the extraction", async () => {
    const handle = await extractionTaskHandler()

    await handle({ ...PAYLOAD, isBackupArchive: true }, () => {})

    assert.equal(runExtraction.mock.calls[0]?.[0].isBackupArchive, true)
  })

  it("carries a downloaded archive through as one, so the strict pair is what it gets", async () => {
    const handle = await extractionTaskHandler()

    await handle({ ...PAYLOAD, filePath: "/versions/vs_client_linux-x64_1.22.6.tar.gz", isBackupArchive: false }, () => {})

    assert.equal(runExtraction.mock.calls[0]?.[0].isBackupArchive, false)
  })

  it("passes the rest of the payload on under the names runExtraction uses", async () => {
    const handle = await extractionTaskHandler()
    const onProgress = (): void => {}

    await handle({ ...PAYLOAD, deleteZip: true, unwrapSingleRootFolder: true, isBackupArchive: false }, onProgress)

    assert.deepEqual(runExtraction.mock.calls[0]?.[0], {
      filePath: PAYLOAD.filePath,
      outputPath: PAYLOAD.outputPath,
      deleteArchive: true,
      unwrapSingleRootFolder: true,
      isBackupArchive: false,
      onProgress
    })
  })
})
