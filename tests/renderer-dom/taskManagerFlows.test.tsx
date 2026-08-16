import type { ReactElement, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { RenderHookResult } from "@testing-library/react"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { ACTIONS, TaskProvider, taskReducer, useTaskContext } from "@renderer/contexts/TaskManagerContext"
import type { TaskNotificationsMode, TaskType } from "@renderer/contexts/TaskManagerContext"

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
 * observe TaskNotificationsMode's gating (showsStart/showsSuccess/showsError
 * in TaskManagerContext.tsx) from outside the module.
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
})

describe("useTaskContext", () => {
  it("throws when used outside a TaskProvider", () => {
    expect(() => renderHook(() => useTaskContext())).toThrow(/must be used within an TaskProvider/)
  })
})

describe("TaskManagerContext notification gating (PR #41)", () => {
  const cases: Array<{ mode: TaskNotificationsMode; outcome: "success" | "error"; expectedTypes: string[] }> = [
    { mode: "all", outcome: "success", expectedTypes: ["info", "success"] },
    { mode: "all", outcome: "error", expectedTypes: ["info", "error"] },
    { mode: "start", outcome: "success", expectedTypes: ["info"] },
    { mode: "start", outcome: "error", expectedTypes: ["info"] },
    { mode: "end", outcome: "success", expectedTypes: ["success"] },
    { mode: "end", outcome: "error", expectedTypes: ["error"] },
    { mode: "none", outcome: "success", expectedTypes: [] },
    { mode: "none", outcome: "error", expectedTypes: [] },
    { mode: "progress", outcome: "success", expectedTypes: ["info", "success"] },
    { mode: "progress", outcome: "error", expectedTypes: ["info"] }
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
      void result.current.task.startDownload("Name", "desc", "none", "https://x", "/tmp/out", "file.zip", onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks.length).toBe(1))
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
      void result.current.task.startExtract("Name", "desc", "none", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks.length).toBe(1))
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
      void result.current.task.startCompress("Name", "desc", "none", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    await waitFor(() => expect(result.current.task.tasks.length).toBe(1))
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
      await result.current.task.startExtract("Name", "desc", "all", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    expect(changePerms).not.toHaveBeenCalled()
    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("Extraction failed")
    expect(result.current.task.tasks[0]?.status).toBe("failed")
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["info", "error"])
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
      await result.current.task.startExtract("Name", "desc", "none", "/tmp/a.zip", "/tmp/out", false, onFinish)
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
      await result.current.task.startExtract("Name", "desc", "none", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("chmod EPERM")
  })

  it("resolves onFinish(true, null) and shows start+success toasts when extraction and chmod both succeed", async () => {
    installMockWindowApi({
      pathsManager: {
        extractOnPath: vi.fn(async () => true),
        changePerms: vi.fn(async () => true)
      }
    })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startExtract("Name", "desc", "all", "/tmp/a.zip", "/tmp/out", false, onFinish)
    })

    expect(onFinish).toHaveBeenCalledWith(true, null)
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["info", "success"])
  })
})

describe("startCompress error arms", () => {
  it("fails the task when compressOnPath resolves false", async () => {
    installMockWindowApi({ pathsManager: { compressOnPath: vi.fn(async () => false) } })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startCompress("Name", "desc", "all", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("Compression failed")
    expect(result.current.task.tasks[0]?.status).toBe("failed")
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["info", "error"])
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
      await result.current.task.startCompress("Name", "desc", "none", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("no space left")
  })

  it("resolves onFinish(true, null) and shows only the start toast for mode=start", async () => {
    installMockWindowApi({ pathsManager: { compressOnPath: vi.fn(async () => true) } })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startCompress("Name", "desc", "start", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    expect(onFinish).toHaveBeenCalledWith(true, null)
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["info"])
  })

  it("resolves onFinish(true, null) and shows the start and success toasts for mode=all", async () => {
    installMockWindowApi({ pathsManager: { compressOnPath: vi.fn(async () => true) } })

    const { result } = renderTaskProbe()
    const onFinish = vi.fn()
    await act(async () => {
      await result.current.task.startCompress("Name", "desc", "all", "/tmp/in", "/tmp/out", "out.zip", onFinish)
    })

    expect(onFinish).toHaveBeenCalledWith(true, null)
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["info", "success"])
  })

  it("passes a custom compressionLevel straight through to compressOnPath", async () => {
    const compressOnPath = vi.fn(async () => true)
    installMockWindowApi({ pathsManager: { compressOnPath } })

    const { result } = renderTaskProbe()
    await act(async () => {
      await result.current.task.startCompress("Name", "desc", "none", "/tmp/in", "/tmp/out", "out.zip", vi.fn(), 9)
    })

    expect(compressOnPath).toHaveBeenCalledWith(expect.any(String), "/tmp/in", "/tmp/out", "out.zip", 9)
  })
})

describe("removeTask", () => {
  it("removes a task from state through the context wrapper", async () => {
    installMockWindowApi({ pathsManager: { downloadOnPath: vi.fn(() => new Promise<string>(() => {})) } })

    const { result } = renderTaskProbe()
    act(() => {
      void result.current.task.startDownload("Name", "desc", "none", "https://x", "/tmp/out", "file.zip", vi.fn())
    })

    await waitFor(() => expect(result.current.task.tasks.length).toBe(1))
    const id = result.current.task.tasks[0]!.id

    act(() => result.current.task.removeTask(id))
    await waitFor(() => expect(result.current.task.tasks.length).toBe(0))
  })
})
