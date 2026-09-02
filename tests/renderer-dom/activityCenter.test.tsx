import type { ReactElement, ReactNode } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { TASK_NOTIFICATION_POLICIES, TaskProvider, useTaskContext } from "@renderer/contexts/TaskManagerContext"
import ActivityCenter from "@renderer/components/ui/ActivityCenter"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"

import "@renderer/i18n"

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <NotificationsProvider>
      <TaskProvider>{children}</TaskProvider>
    </NotificationsProvider>
  )
}

function Controls(): JSX.Element {
  const { addNotification } = useNotificationsContext()
  const { startDownload } = useTaskContext()

  return (
    <>
      <button onClick={() => addNotification("A notification worth keeping", "info")}>Add notification</button>
      <button onClick={() => addNotification("A successful action", "success")}>Add success</button>
      <button onClick={() => addNotification("Something went wrong", "error")}>Add error</button>
      <button onClick={() => addNotification("Only a toast", "info", { presentation: "toast" })}>Add toast only</button>
      <button onClick={() => addNotification("A decision is required", "warning", { actions: [{ id: "resolve", label: "Resolve" }] })}>Add actionable warning</button>
      <button onClick={() => void startDownload("Example download", "An active download", TASK_NOTIFICATION_POLICIES.individual, "https://example.test/file", "/tmp", "file.zip", () => {})}>
        Start task
      </button>
    </>
  )
}

/** Opens the Activity Center popover by its accessible name, whatever the counts. */
function openCenter(): void {
  fireEvent.click(screen.getByRole("button", { name: /^Activity Center:/ }))
}

/** The open panel body, so row lookups do not collide with a toast of the same text. */
function panel(): HTMLElement {
  return screen.getByRole("region", { name: "Activity Center" })
}

/** Exposes the presented toast so timer behaviour is read off state, not the DOM. */
function ActiveToastProbe(): JSX.Element {
  const { activeToast } = useNotificationsContext()
  return <span data-testid="active-toast">{activeToast?.body ?? "none"}</span>
}

describe("ActivityCenter", () => {
  it("keeps active work discoverable and uses a semantic activity trigger", () => {
    installMockWindowApi({ pathsManager: { downloadOnPath: vi.fn(() => new Promise<string>(() => {})) } })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Start task" }))

    const trigger = screen.getByRole("button", { name: "Activity Center: 1 active task, 0 new notifications" })
    expect(trigger.className).toContain("border-vsl")
    expect(trigger.querySelector("svg")).toBeTruthy()
    expect(trigger.querySelector("span")?.className).toContain("-right-1")

    fireEvent.keyDown(trigger, { key: "Enter" })

    expect(screen.getByText("Activity Center")).toBeTruthy()
    const activityRegion = screen.getByRole("region", { name: "Activity Center" })
    expect(within(activityRegion).getByRole("region", { name: "In progress" })).toBeTruthy()
    const taskDetails = screen.getByText("Example download").parentElement
    expect(taskDetails?.textContent).toContain("Downloading")
    expect(taskDetails?.textContent).toContain("Starting")
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0")
    expect(screen.getByText("0%")).toBeTruthy()
    expect(screen.queryByText(/Pause|Cancel|Retry/)).toBeNull()
  })

  it("pluralizes active tasks and new notifications independently", () => {
    installMockWindowApi({ pathsManager: { downloadOnPath: vi.fn(() => new Promise<string>(() => {})) } })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Start task" }))
    fireEvent.click(screen.getByRole("button", { name: "Start task" }))
    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))

    expect(screen.getByRole("button", { name: "Activity Center: 2 active tasks, 2 new notifications" })).toBeTruthy()
  })

  it("does not render the old queued-task empty state", () => {
    installMockWindowApi()

    render(<ActivityCenter />, { wrapper })
    openCenter()

    expect(screen.getByText("No activity right now.")).toBeTruthy()
    expect(screen.queryByText(/tasks queued/i)).toBeNull()
  })

  it("opening the center clears the new-activity dot but leaves the rows unread", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <NotificationsOverlay />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    const trigger = screen.getByRole("button", { name: "Activity Center: 0 active tasks, 1 new notification" })
    expect(trigger.querySelector("span.bg-vsl")).toBeTruthy()

    openCenter()

    expect(screen.getByRole("button", { name: "Activity Center: 0 active tasks, 0 new notifications" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /^Activity Center:/ }).querySelector("span.bg-vsl")).toBeNull()
    const row = within(panel()).getByText("A notification worth keeping").closest("li") as HTMLElement
    expect(within(panel()).getByRole("region", { name: "Notifications" })).toBeTruthy()
    expect(within(panel()).getAllByRole("listitem")).toHaveLength(1)
    expect(row.className).toContain("bg-zinc-800/30")
    expect(within(row).getByRole("button", { name: "Mark as read" })).toBeTruthy()
    expect(screen.getByText("0 running, 1 unread")).toBeTruthy()
  })

  it("marks a notification that arrives while the center is open as seen too", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    openCenter()
    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))

    expect(screen.getByRole("button", { name: "Activity Center: 0 active tasks, 0 new notifications" })).toBeTruthy()
  })

  it("round-trips a per-item read toggle without relighting the dot", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    openCenter()

    const row = (): HTMLElement => within(panel()).getByText("A notification worth keeping").closest("li") as HTMLElement

    fireEvent.click(within(row()).getByRole("button", { name: "Mark as read" }))
    expect(within(row()).getByRole("button", { name: "Mark as unread" })).toBeTruthy()
    expect(row().className).not.toContain("bg-zinc-800/30")
    expect(screen.getByText("0 running, 0 unread")).toBeTruthy()

    fireEvent.click(within(row()).getByRole("button", { name: "Mark as unread" }))
    expect(row().className).toContain("bg-zinc-800/30")
    expect(screen.getByText("0 running, 1 unread")).toBeTruthy()
    // The dot never comes back: `seen` is sticky.
    expect(screen.getByRole("button", { name: "Activity Center: 0 active tasks, 0 new notifications" })).toBeTruthy()
  })

  it("keeps notification history after the toast is dismissed and clears only read records", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <NotificationsOverlay />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Discard notification" }))
    openCenter()

    expect(within(panel()).getByText("A notification worth keeping")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    expect(screen.getByText("0 running, 0 unread")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Clear read" }))
    expect(within(panel()).queryByText("A notification worth keeping")).toBeNull()
  })

  it("marks a hand-dismissed banner seen but lets an expired one stay new", () => {
    vi.useFakeTimers()
    try {
      installMockWindowApi()

      const view = render(
        <>
          <Controls />
          <NotificationsOverlay />
          <ActivityCenter />
        </>,
        { wrapper }
      )

      fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
      fireEvent.click(screen.getByRole("button", { name: "Discard notification" }))
      expect(screen.getByRole("button", { name: "Activity Center: 0 active tasks, 0 new notifications" })).toBeTruthy()

      view.unmount()

      const fresh = render(
        <>
          <Controls />
          <NotificationsOverlay />
          <ActivityCenter />
        </>,
        { wrapper }
      )
      fresh.rerender(
        <>
          <Controls />
          <NotificationsOverlay />
          <ActivityCenter />
        </>
      )

      fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
      act(() => vi.advanceTimersByTime(5_000))
      expect(screen.getByRole("button", { name: "Activity Center: 0 active tasks, 1 new notification" })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not restart the toast countdown when the center is opened", () => {
    vi.useFakeTimers()
    try {
      installMockWindowApi()

      render(
        <>
          <Controls />
          <ActiveToastProbe />
          <NotificationsOverlay />
          <ActivityCenter />
        </>,
        { wrapper }
      )

      fireEvent.click(screen.getByRole("button", { name: "Add success" }))
      expect(screen.getByTestId("active-toast").textContent).toBe("A successful action")

      act(() => vi.advanceTimersByTime(2_000))
      openCenter()
      act(() => vi.advanceTimersByTime(3_000))

      // 5s total elapsed against a 4.5s duration: opening the panel mutated the
      // record (seen) but must not have restarted the countdown.
      expect(screen.getByTestId("active-toast").textContent).toBe("none")
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows the countdown for transient toasts and keeps actionable warnings open", async () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add success" }))
    expect(screen.getByTestId("toast-timer")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Discard notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Add actionable warning" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy())
    expect(screen.queryByTestId("toast-timer")).toBeNull()
  })

  it("records how an actionable notification was answered", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add actionable warning" }))
    openCenter()

    const row = screen.getByText("A decision is required").closest("li") as HTMLElement
    fireEvent.click(within(row).getByRole("button", { name: "Resolve" }))

    expect(within(row).queryByRole("button", { name: "Resolve" })).toBeNull()
    expect(within(row).getByText("Answered: Resolve")).toBeTruthy()
  })

  it("offers Clear read only when a read record is not still awaiting an answer", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add actionable warning" }))
    openCenter()
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    expect(screen.queryByRole("button", { name: "Clear read" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    fireEvent.click(screen.getByRole("button", { name: "Clear read" }))

    expect(screen.queryByText("A notification worth keeping")).toBeNull()
    expect(screen.getByText("A decision is required")).toBeTruthy()
  })

  it("marks a 100 percent launcher update as finalizing until the downloaded event", () => {
    const listeners: { progress?: (payload: { version: string; progress: number }) => void } = {}
    installMockWindowApi({
      appUpdater: {
        onUpdateDownloadProgress: vi.fn((callback) => {
          listeners.progress = callback
          return (): void => {}
        })
      }
    })

    render(
      <>
        <ActivityCenter />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    act(() => listeners.progress?.({ version: "1.7.0-beta.6", progress: 100 }))
    openCenter()

    expect(screen.getByText(/Finalizing/)).toBeTruthy()
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100")
    expect(screen.queryByTitle("Discard task")).toBeNull()
  })
})

describe("NotificationsOverlay live region", () => {
  it("is a persistent polite region that only errors escalate to alert", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    const region = screen.getByRole("status")
    expect(region.getAttribute("aria-live")).toBe("polite")

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    expect(within(region).queryByRole("alert")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Discard notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Add error" }))
    expect(screen.getByRole("alert")).toBeTruthy()
  })
})

describe("NotificationsContext history caps", () => {
  it("never lets queued toast-only records push real history out", () => {
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => {
      for (let index = 0; index < 60; index += 1) result.current.addNotification(`toast ${index}`, "info", { presentation: "toast" })
      for (let index = 0; index < 3; index += 1) result.current.addNotification(`kept ${index}`, "info")
    })

    expect(result.current.history).toHaveLength(3)
    expect(result.current.history.map((record) => record.body)).toEqual(["kept 0", "kept 1", "kept 2"])
  })

  it("caps center history at fifty, dropping the oldest", () => {
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => {
      for (let index = 0; index < 55; index += 1) result.current.addNotification(`center ${index}`, "info", { presentation: "center" })
    })

    expect(result.current.history).toHaveLength(50)
    expect(result.current.history[0]?.body).toBe("center 5")
  })

  it("drops a record and its queued toast on removeNotification", () => {
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => result.current.addNotification("first", "info"))
    const id = result.current.history[0]?.id as string
    act(() => result.current.addNotification("second", "info"))
    act(() => result.current.removeNotification(id))

    expect(result.current.history.map((record) => record.body)).toEqual(["second"])
  })

  it("skips a queued toast whose record was removed before its turn", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <ProbeRemoveSecond />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Add error" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove second" }))
    fireEvent.click(screen.getByRole("button", { name: "Discard notification" }))

    expect(screen.queryByText("Something went wrong")).toBeNull()
  })
})

function ProbeRemoveSecond(): JSX.Element {
  const { history, removeNotification } = useNotificationsContext()
  return <button onClick={() => history[1] && removeNotification(history[1].id)}>Remove second</button>
}
