import type { ReactElement, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { RenderHookResult } from "@testing-library/react"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { ACTIONS, TaskProvider, taskReducer, useTaskContext } from "@renderer/contexts/TaskManagerContext"
import type { TaskNotificationsMode, TaskType } from "@renderer/contexts/TaskManagerContext"

import { expectHookThrowsOutsideProvider } from "./helpers/render"
import { installMockWindowApi } from "./helpers/windowApi"

// Registers the i18n instance useTranslation() reads inside TaskProvider and
// NotificationsProvider, same as renderWithProviders (./helpers/render) does.
import "@renderer/i18n"

/**
 * Branch coverage for src/renderer/src/contexts/TaskManagerContext.tsx beyond
 * taskManagerStartInstall.test.tsx's startInstall-only coverage (80% stmts,
 * 54% branches measured before this file): startDownload/startExtract/
 * startCompress were entirely untested, along with the progress-listener
 * effect all three share and the pure taskReducer/useTaskContext guard.
 *
 * The probe is a composite hook mounting both TaskProvider and
 * NotificationsProvider so a test can read back which toasts a run actually
 * produced (`result.current.notifications.notifications`), the only way to
 * observe TaskNotificationsMode's gating (showsStart/showsError in
 * TaskManagerContext.tsx) from outside the module.
 */
function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <NotificationsProvider>
      <TaskProvider>{children}</TaskProvider>
    </NotificationsProvider>
  )
}

type TaskProbe = { task: ReturnType<typeof useTaskContext>; notifications: ReturnType<typeof useNotificationsContext> }

function renderTaskProbe(): RenderHookResult<TaskProbe, unknown> {
  return renderHook(() => ({ task: useTaskContext(), notifications: useNotificationsContext() }), { wrapper })
}

describe("taskReducer", () => {
  const baseTask: TaskType = { id: "a", name: "A", desc: "", type: "download", progress: 0, status: "pending" }

  it("REMOVE_TASK filters out the matching task, leaving the rest untouched", () => {
    const other: TaskType = { ...baseTask, id: "b" }
    const result = taskReducer([baseTask, other], { type: ACTIONS.REMOVE_TASK, payload: { id: "a" } })
    expect(result).toEqual([other])
  })

  it("an unrecognized action returns the state unchanged", () => {
    const state = [baseTask]
    // @ts-expect-error deliberately outside TaskAction's union, to exercise the reducer's default arm
    const result = taskReducer(state, { type: "NOT_A_REAL_ACTION" })
    expect(result).toBe(state)
  })

  it("UPDATE_TASK returns the same state array when every updated field already holds that value", () => {
    const done: TaskType = { ...baseTask, progress: 100, status: "completed" }
    const state = [done]
    const result = taskReducer(state, { type: ACTIONS.UPDATE_TASK, payload: { id: "a", updates: { progress: 100, status: "completed" } } })
    expect(result).toBe(state)
  })

  it("UPDATE_TASK still rewrites the task when one field of several differs", () => {
    const state = [{ ...baseTask, progress: 97, status: "in-progress" as const }]
    const result = taskReducer(state, { type: ACTIONS.UPDATE_TASK, payload: { id: "a", updates: { progress: 100, status: "completed" } } })
    expect(result).not.toBe(state)
    expect(result[0]).toMatchObject({ progress: 100, status: "completed" })
  })

  it("UPDATE_TASK for an id that is not in state returns the same state array", () => {
    const state = [baseTask]
    const result = taskReducer(state, { type: ACTIONS.UPDATE_TASK, payload: { id: "nope", updates: { status: "completed" } } })
    expect(result).toBe(state)
  })
})

describe("useTaskContext", () => {
  it("throws when used outside a TaskProvider", () => {
    expectHookThrowsOutsideProvider(useTaskContext, /must be used within an TaskProvider/)
  })
})

describe("TaskManagerContext notification gating (PR #41)", () => {
  const cases: Array<{ mode: TaskNotificationsMode; outcome: "success" | "error"; expectedTypes: string[] }> = [
    { mode: "end", outcome: "success", expectedTypes: ["success"] },
    { mode: "end", outcome: "error", expectedTypes: ["error"] },
    { mode: "progress", outcome: "success", expectedTypes: ["success"] },
    { mode: "progress", outcome: "error", expectedTypes: [] }
  ]

  it.each(cases)("mode=$mode outcome=$outcome shows $expectedTypes", async ({ mode, outcome, expectedTypes }) => {
    installMockWindowApi({
      pathsManager: {
        downloadOnPath: vi.fn(async () => {
          if (outcome === "error") throw new Error("network down")
          return "/tmp/out/file.zip"
        })
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    await act(async () => {
      await result.current.task.startDownload("Name", "desc", mode, "https://x", "/tmp/out", "file.zip", onFinish)
    })

    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(expectedTypes)
  })
})

describe("progress event handling", () => {
  it("updates a download task's progress and marks it completed at 100", async () => {
    let progressHandler: ProgressCallback | undefined
    let resolveDownload: (path: string) => void = () => {}
    const downloadPromise = new Promise<string>((resolvePromise) => {
      resolveDownload = resolvePromise
    })

    installMockWindowApi({
      pathsManager: {
        onDownloadProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        }),
        downloadOnPath: vi.fn(() => downloadPromise)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    act(() => {
      void result.current.task.startDownload("Name", "desc", "end", "https://x", "/tmp/out", "file.zip", onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks).toHaveLength(1))
    const taskId = result.current.task.tasks[0]!.id
    expect(result.current.task.tasks[0]!.status).toBe("pending")

    act(() => progressHandler?.({ id: taskId, progress: 42 }))
    await waitFor(() => {
      const task = result.current.task.tasks.find((t) => t.id === taskId)
      expect(task?.progress).toBe(42)
      expect(task?.status).toBe("in-progress")
    })

    // An update for an unrelated task id must not touch this one.
    act(() => progressHandler?.({ id: "some-other-task", progress: 99 }))
    expect(result.current.task.tasks.find((t) => t.id === taskId)?.progress).toBe(42)

    act(() => progressHandler?.({ id: taskId, progress: 100 }))
    await waitFor(() => expect(result.current.task.tasks.find((t) => t.id === taskId)?.status).toBe("completed"))

    act(() => resolveDownload("/tmp/out/file.zip"))
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true, "/tmp/out/file.zip", null))
  })

  it("updates an extract task's progress and marks it completed at 100", async () => {
    let progressHandler: ProgressCallback | undefined
    let resolveExtract: (ok: boolean) => void = () => {}
    const extractPromise = new Promise<boolean>((resolvePromise) => {
      resolveExtract = resolvePromise
    })

    installMockWindowApi({
      pathsManager: {
        onExtractProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        }),
        extractOnPath: vi.fn(() => extractPromise),
        changePerms: vi.fn(async () => true)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    act(() => {
      void result.current.task.startExtract("Name", "desc", "end", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks).toHaveLength(1))
    const taskId = result.current.task.tasks[0]!.id

    act(() => progressHandler?.({ id: taskId, progress: 50 }))
    await waitFor(() => {
      const task = result.current.task.tasks.find((t) => t.id === taskId)
      expect(task?.progress).toBe(50)
      expect(task?.status).toBe("in-progress")
    })

    act(() => progressHandler?.({ id: taskId, progress: 100 }))
    await waitFor(() => expect(result.current.task.tasks.find((t) => t.id === taskId)?.status).toBe("completed"))

    act(() => resolveExtract(true))
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true, null))
  })

  it("updates a compress task's progress and marks it completed at 100", async () => {
    let progressHandler: ProgressCallback | undefined
    let resolveCompress: (ok: boolean) => void = () => {}
    const compressPromise = new Promise<boolean>((resolvePromise) => {
      resolveCompress = resolvePromise
    })

    installMockWindowApi({
      pathsManager: {
        onCompressProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        }),
        compressOnPath: vi.fn(() => compressPromise)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    act(() => {
      void result.current.task.startCompress("Name", "desc", "end", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks).toHaveLength(1))
    const taskId = result.current.task.tasks[0]!.id

    act(() => progressHandler?.({ id: taskId, progress: 10 }))
    await waitFor(() => {
      const task = result.current.task.tasks.find((t) => t.id === taskId)
      expect(task?.progress).toBe(10)
      expect(task?.status).toBe("in-progress")
    })

    act(() => progressHandler?.({ id: taskId, progress: 100 }))
    await waitFor(() => expect(result.current.task.tasks.find((t) => t.id === taskId)?.status).toBe("completed"))

    act(() => resolveCompress(true))
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true, null))
  })
})

/**
 * Issue #108: a task used to reach "completed" only through a progress event
 * landing exactly on 100. Any run whose last tick came in under 100 (rounding,
 * a source with no terminal tick, an installer whose payload was read out
 * rather than run) left the task manager showing work that had actually
 * finished as still running. Each flow now completes its own task when the
 * call it awaited resolves, which makes the progress events cosmetic.
 */
describe("completion driven by the resolved operation", () => {
  it("completes a download whose last progress event stopped at 97", async () => {
    let progressHandler: ProgressCallback | undefined
    let resolveDownload: (path: string) => void = () => {}
    const downloadPromise = new Promise<string>((resolvePromise) => {
      resolveDownload = resolvePromise
    })

    installMockWindowApi({
      pathsManager: {
        onDownloadProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        }),
        downloadOnPath: vi.fn(() => downloadPromise)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    act(() => {
      void result.current.task.startDownload("Name", "desc", "end", "https://x", "/tmp/out", "file.zip", onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks).toHaveLength(1))
    const taskId = result.current.task.tasks[0]!.id

    act(() => progressHandler?.({ id: taskId, progress: 97 }))
    await waitFor(() => expect(result.current.task.tasks.find((t) => t.id === taskId)?.status).toBe("in-progress"))

    await act(async () => resolveDownload("/tmp/out/file.zip"))

    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true, "/tmp/out/file.zip", null))
    expect(result.current.task.tasks.find((t) => t.id === taskId)).toMatchObject({ progress: 100, status: "completed" })
  })

  it("completes an extraction whose last progress event stopped at 97", async () => {
    let progressHandler: ProgressCallback | undefined
    let resolveExtract: (ok: boolean) => void = () => {}
    const extractPromise = new Promise<boolean>((resolvePromise) => {
      resolveExtract = resolvePromise
    })

    installMockWindowApi({
      pathsManager: {
        onExtractProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        }),
        extractOnPath: vi.fn(() => extractPromise),
        changePerms: vi.fn(async () => true)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    act(() => {
      void result.current.task.startExtract("Name", "desc", "end", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks).toHaveLength(1))
    const taskId = result.current.task.tasks[0]!.id

    act(() => progressHandler?.({ id: taskId, progress: 97 }))
    await waitFor(() => expect(result.current.task.tasks.find((t) => t.id === taskId)?.status).toBe("in-progress"))

    await act(async () => resolveExtract(true))

    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true, null))
    expect(result.current.task.tasks.find((t) => t.id === taskId)).toMatchObject({ progress: 100, status: "completed" })
  })

  it("completes a compression whose last progress event stopped at 97", async () => {
    let progressHandler: ProgressCallback | undefined
    let resolveCompress: (ok: boolean) => void = () => {}
    const compressPromise = new Promise<boolean>((resolvePromise) => {
      resolveCompress = resolvePromise
    })

    installMockWindowApi({
      pathsManager: {
        onCompressProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        }),
        compressOnPath: vi.fn(() => compressPromise)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    act(() => {
      void result.current.task.startCompress("Name", "desc", "end", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks).toHaveLength(1))
    const taskId = result.current.task.tasks[0]!.id

    act(() => progressHandler?.({ id: taskId, progress: 97 }))
    await waitFor(() => expect(result.current.task.tasks.find((t) => t.id === taskId)?.status).toBe("in-progress"))

    await act(async () => resolveCompress(true))

    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true, null))
    expect(result.current.task.tasks.find((t) => t.id === taskId)).toMatchObject({ progress: 100, status: "completed" })
  })

  it("completes an installation, which gets no progress event of its own when the payload is read out", async () => {
    installMockWindowApi({
      pathsManager: { runInstaller: vi.fn(async () => ({ ok: true }) as InstallerRunResult) }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    await act(async () => {
      await result.current.task.startInstall("Install", "desc", "end", "/tmp/setup.exe", "/tmp/out", true, onFinish)
    })

    expect(onFinish).toHaveBeenCalledWith(true, null)
    expect(result.current.task.tasks[0]).toMatchObject({ progress: 100, status: "completed" })
  })

  it("completes once when a 100 event and the resolved download both land, leaving the state array untouched the second time", async () => {
    let progressHandler: ProgressCallback | undefined
    let resolveDownload: (path: string) => void = () => {}
    const downloadPromise = new Promise<string>((resolvePromise) => {
      resolveDownload = resolvePromise
    })

    installMockWindowApi({
      pathsManager: {
        onDownloadProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        }),
        downloadOnPath: vi.fn(() => downloadPromise)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    act(() => {
      void result.current.task.startDownload("Name", "desc", "end", "https://x", "/tmp/out", "file.zip", onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks).toHaveLength(1))
    const taskId = result.current.task.tasks[0]!.id

    act(() => progressHandler?.({ id: taskId, progress: 100 }))
    await waitFor(() => expect(result.current.task.tasks.find((t) => t.id === taskId)?.status).toBe("completed"))
    const tasksAfterTheEvent = result.current.task.tasks

    await act(async () => resolveDownload("/tmp/out/file.zip"))
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true, "/tmp/out/file.zip", null))

    // Same array instance: the success path's dispatch found nothing to change,
    // so useReducer had no new state to render and the task never flickered
    // out of "completed" and back into it.
    expect(result.current.task.tasks).toBe(tasksAfterTheEvent)
    expect(result.current.task.tasks.find((t) => t.id === taskId)).toMatchObject({ progress: 100, status: "completed" })
  })

  it("leaves a rejected download failed, at the progress it died on", async () => {
    let progressHandler: ProgressCallback | undefined
    let rejectDownload: (err: Error) => void = () => {}
    const downloadPromise = new Promise<string>((_resolvePromise, rejectPromise) => {
      rejectDownload = rejectPromise
    })

    installMockWindowApi({
      pathsManager: {
        onDownloadProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        }),
        downloadOnPath: vi.fn(() => downloadPromise)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()

    act(() => {
      void result.current.task.startDownload("Name", "desc", "end", "https://x", "/tmp/out", "file.zip", onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks).toHaveLength(1))
    const taskId = result.current.task.tasks[0]!.id

    act(() => progressHandler?.({ id: taskId, progress: 62 }))
    await waitFor(() => expect(result.current.task.tasks.find((t) => t.id === taskId)?.progress).toBe(62))

    await act(async () => rejectDownload(new Error("connection reset")))

    await waitFor(() => expect(onFinish).toHaveBeenCalled())
    const [status, , error] = onFinish.mock.calls[0] as [boolean, string, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("connection reset")
    expect(result.current.task.tasks.find((t) => t.id === taskId)).toMatchObject({ progress: 62, status: "failed" })
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["error"])
  })
})

describe("startExtract error arms", () => {
  it("fails the task when extractOnPath resolves false, without ever calling changePerms", async () => {
    const changePerms = vi.fn(async () => true)
    installMockWindowApi({
      pathsManager: {
        extractOnPath: vi.fn(async () => false),
        changePerms
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startExtract("Name", "desc", "end", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    expect(changePerms).not.toHaveBeenCalled()
    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("Extraction failed")
    expect(result.current.task.tasks[0]?.status).toBe("failed")
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["error"])
  })

  it("fails the task when extractOnPath itself rejects", async () => {
    installMockWindowApi({
      pathsManager: {
        extractOnPath: vi.fn(async () => {
          throw new Error("disk full")
        }),
        changePerms: vi.fn(async () => true)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startExtract("Name", "desc", "end", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("disk full")
  })

  it("fails the task when the post-extraction chmod rejects (awaited on purpose, not fire-and-forget)", async () => {
    installMockWindowApi({
      pathsManager: {
        extractOnPath: vi.fn(async () => true),
        changePerms: vi.fn(async () => {
          throw new Error("chmod EPERM")
        })
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startExtract("Name", "desc", "end", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("chmod EPERM")
  })

  it("resolves onFinish(true, null) and shows only the completion toast when extraction and chmod both succeed", async () => {
    installMockWindowApi({
      pathsManager: {
        extractOnPath: vi.fn(async () => true),
        changePerms: vi.fn(async () => true)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startExtract("Name", "desc", "progress", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    expect(onFinish).toHaveBeenCalledWith(true, null)
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["success"])
  })
})

describe("startCompress error arms", () => {
  it("fails the task when compressOnPath resolves false", async () => {
    installMockWindowApi({ pathsManager: { compressOnPath: vi.fn(async () => false) } })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startCompress("Name", "desc", "end", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("Compression failed")
    expect(result.current.task.tasks[0]?.status).toBe("failed")
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["error"])
  })

  it("fails the task when compressOnPath itself rejects", async () => {
    installMockWindowApi({
      pathsManager: {
        compressOnPath: vi.fn(async () => {
          throw new Error("no space left")
        })
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startCompress("Name", "desc", "end", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("no space left")
  })

  it("resolves onFinish(true, null) and shows the start and success toasts for mode=progress", async () => {
    installMockWindowApi({ pathsManager: { compressOnPath: vi.fn(async () => true) } })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startCompress("Name", "desc", "progress", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    expect(onFinish).toHaveBeenCalledWith(true, null)
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["success"])
  })

  it("passes a custom compressionLevel straight through to compressOnPath", async () => {
    const compressOnPath = vi.fn(async () => true)
    installMockWindowApi({ pathsManager: { compressOnPath } })

    const { result } = renderTaskProbe()
    await act(async () => {
      await result.current.task.startCompress("Name", "desc", "end", "/tmp/in", "/tmp/out", "out.zip", vi.fn(), 9)
    })

    expect(compressOnPath).toHaveBeenCalledWith(expect.any(String), "/tmp/in", "/tmp/out", "out.zip", 9)
  })
})

describe("removeTask", () => {
  it("removes a task from state through the context wrapper", async () => {
    installMockWindowApi({ pathsManager: { downloadOnPath: vi.fn(() => new Promise<string>(() => {})) } })

    const { result } = renderTaskProbe()
    act(() => {
      void result.current.task.startDownload("Name", "desc", "end", "https://x", "/tmp/out", "file.zip", vi.fn())
    })

    await waitFor(() => expect(result.current.task.tasks).toHaveLength(1))
    const id = result.current.task.tasks[0]!.id

    act(() => result.current.task.removeTask(id))
    await waitFor(() => expect(result.current.task.tasks).toHaveLength(0))
  })
})
