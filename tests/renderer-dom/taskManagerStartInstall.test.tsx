import type { ReactElement, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { TASK_NOTIFICATION_POLICIES, TaskProvider, useTaskContext } from "@renderer/contexts/TaskManagerContext"

import { installMockWindowApi } from "./helpers/windowApi"

// Registers the i18n instance useTranslation() reads inside TaskProvider and
// NotificationsProvider, same as renderWithProviders (./helpers/render) does.
import "@renderer/i18n"

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <NotificationsProvider>
      <TaskProvider>{children}</TaskProvider>
    </NotificationsProvider>
  )
}

/**
 * startInstall's onFinish callback stays boolean-shaped for its callers even
 * though RUN_INSTALLER now resolves a typed {@link InstallerRunResult}
 * (global.d.ts): these pin that the typed result still drives the right
 * boolean, and that the refusal reason survives onto the thrown Error's
 * message for the debug log line in TaskManagerContext.tsx.
 */
describe("TaskManagerContext.startInstall", () => {
  it("resolves onFinish(true, null) when RUN_INSTALLER reports ok", async () => {
    installMockWindowApi({
      pathsManager: { runInstaller: vi.fn(async () => ({ ok: true }) as InstallerRunResult) }
    })

    const { result } = renderHook(() => useTaskContext(), { wrapper })
    const onFinish = vi.fn()

    await act(async () => {
      await result.current.startInstall("Install", "desc", TASK_NOTIFICATION_POLICIES.individual, "/tmp/setup.exe", "/tmp/out", true, onFinish)
    })

    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true, null))
  })

  it("resolves onFinish(false, Error) carrying the reason when RUN_INSTALLER times out", async () => {
    installMockWindowApi({
      pathsManager: { runInstaller: vi.fn(async () => ({ ok: false, reason: "installer-timed-out" }) as InstallerRunResult) }
    })

    const { result } = renderHook(() => useTaskContext(), { wrapper })
    const onFinish = vi.fn()

    await act(async () => {
      await result.current.startInstall("Install", "desc", TASK_NOTIFICATION_POLICIES.individual, "/tmp/setup.exe", "/tmp/out", true, onFinish)
    })

    await waitFor(() => expect(onFinish).toHaveBeenCalled())
    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("installer-timed-out")
  })

  it("resolves onFinish(false, Error) for a plain installer-failed reason too", async () => {
    installMockWindowApi({
      pathsManager: { runInstaller: vi.fn(async () => ({ ok: false, reason: "installer-failed" }) as InstallerRunResult) }
    })

    const { result } = renderHook(() => useTaskContext(), { wrapper })
    const onFinish = vi.fn()

    await act(async () => {
      await result.current.startInstall("Install", "desc", TASK_NOTIFICATION_POLICIES.individual, "/tmp/setup.exe", "/tmp/out", true, onFinish)
    })

    await waitFor(() => expect(onFinish).toHaveBeenCalled())
    const [status, error] = onFinish.mock.calls[0] as [boolean, Error | null]
    expect(status).toBe(false)
    expect(error?.message).toContain("installer-failed")
  })

  /**
   * The tests above only ever look at onFinish, so these pin the terminal
   * notifications for both task policies.
   */
  it("shows the completion toast when RUN_INSTALLER reports ok for caller-handled failures", async () => {
    installMockWindowApi({
      pathsManager: { runInstaller: vi.fn(async () => ({ ok: true }) as InstallerRunResult) }
    })

    const { result } = renderHook(() => ({ task: useTaskContext(), notifications: useNotificationsContext() }), { wrapper })
    const onFinish = vi.fn()

    await act(async () => {
      await result.current.task.startInstall("Install", "desc", TASK_NOTIFICATION_POLICIES.callerHandled, "/tmp/setup.exe", "/tmp/out", true, onFinish)
    })

    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true, null))
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["success"])
  })

  it("shows the generic error toast when RUN_INSTALLER fails for an individual task", async () => {
    installMockWindowApi({
      pathsManager: { runInstaller: vi.fn(async () => ({ ok: false, reason: "installer-failed" }) as InstallerRunResult) }
    })

    const { result } = renderHook(() => ({ task: useTaskContext(), notifications: useNotificationsContext() }), { wrapper })
    const onFinish = vi.fn()

    await act(async () => {
      await result.current.task.startInstall("Install", "desc", TASK_NOTIFICATION_POLICIES.individual, "/tmp/setup.exe", "/tmp/out", true, onFinish)
    })

    await waitFor(() => expect(onFinish).toHaveBeenCalled())
    expect(result.current.notifications.notifications.map((n) => n.type)).toEqual(["error"])
  })
})
