import type { ReactElement, ReactNode } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { MAX_TOAST_BACKLOG } from "@domain/notifications/toastQueue"
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
      <button onClick={() => void startDownload("Doomed download", "A download that dies", TASK_NOTIFICATION_POLICIES.aggregate, "https://example.test/boom", "/tmp", "boom.zip", () => {})}>
        Start failing task
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
    // waitFor, not a bare read: the dismissed banner plays an exit animation with its own countdown
    // still drawn, so on a slow runner both banners are briefly on screen. What this holds is that
    // once only the warning is left, it has no countdown of its own.
    await waitFor(() => expect(screen.queryByTestId("toast-timer")).toBeNull())
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

  it("reads a finished download as completed, not finalizing, when its last tick lands after it finished (#387)", async () => {
    let progressHandler: ProgressCallback | undefined
    let taskId = ""
    let finishDownload: (path: string) => void = () => {}
    const downloadPromise = new Promise<string>((resolvePromise) => {
      finishDownload = resolvePromise
    })

    installMockWindowApi({
      pathsManager: {
        onDownloadProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        }),
        downloadOnPath: vi.fn((id: string) => {
          taskId = id
          return downloadPromise
        })
      }
    })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Start task" }))
    openCenter()
    act(() => progressHandler?.({ id: taskId, progress: 64 }))

    await act(async () => finishDownload("/tmp/file.zip"))
    const row = (): HTMLElement => within(panel()).getByText("Example download").closest("li") as HTMLElement
    expect(row().textContent).toContain("Completed")

    // The tick the main process had already sent when the promise resolved.
    act(() => progressHandler?.({ id: taskId, progress: 100 }))

    expect(row().textContent).toContain("Completed")
    expect(row().textContent).not.toContain("Finalizing")
    expect(within(panel()).queryByRole("progressbar")).toBeNull()
    expect(within(panel()).getByTitle("Discard task")).toBeTruthy()
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

  it("keeps the toast on screen when a burst overflows the toast budget", () => {
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => result.current.addNotification("being read", "info", { presentation: "toast" }))
    expect(result.current.activeToast?.body).toBe("being read")

    act(() => {
      for (let index = 0; index <= MAX_TOAST_BACKLOG; index += 1) result.current.addNotification(`burst ${index}`, "info", { presentation: "toast" })
    })

    expect(result.current.activeToast?.body).toBe("being read")
  })

  it("keeps a both-presentation toast on screen when center history overflows behind it", () => {
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => result.current.addNotification("being read", "info"))
    expect(result.current.activeToast?.body).toBe("being read")

    act(() => {
      for (let index = 0; index < 50; index += 1) result.current.addNotification(`center ${index}`, "info", { presentation: "center" })
    })

    expect(result.current.activeToast?.body).toBe("being read")
    expect(result.current.history).toHaveLength(51)
  })

  it("lets only a full backlog wait behind a both-presentation toast on screen, not one more", () => {
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => result.current.addNotification("being read", "info"))
    act(() => {
      for (let index = 0; index <= MAX_TOAST_BACKLOG; index += 1) result.current.addNotification(`burst ${index}`, "info", { presentation: "toast" })
    })

    const shown: string[] = []
    for (let turns = 0; turns < MAX_TOAST_BACKLOG + 3 && result.current.activeToast; turns += 1) {
      shown.push(result.current.activeToast.body)
      const id = result.current.activeToast.id
      act(() => result.current.dismissToast(id))
    }

    expect(shown).toEqual(["being read", "burst 1", "burst 2", "burst 3", "burst 4"])
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

/** Fires five errors with bodies that can be told apart, so the burst's order is readable. */
function BurstControls(): JSX.Element {
  const { addNotification } = useNotificationsContext()
  return <button onClick={() => [1, 2, 3, 4, 5].forEach((index) => addNotification("burst " + index, "error"))}>Fire five errors</button>
}

/**
 * Runs the fake clock forward in slices, each in its own act.
 *
 * One long advanceTimersByTime only ever moves the queue on by a single toast: the timer for the
 * next one is not scheduled until React has re-rendered and run the hand-off effect, which does
 * not happen until act flushes.
 */
function tick(milliseconds: number): void {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 250) act(() => vi.advanceTimersByTime(250))
}

/** The presented banner itself, so a lookup does not collide with the probe span's copy of its text. */
function toast(): HTMLElement {
  return screen.getByRole("status").firstElementChild as HTMLElement
}

describe("toast queue timing", () => {
  it("puts the last of a five error burst on screen in under nine seconds instead of thirty-two", () => {
    vi.useFakeTimers()
    try {
      installMockWindowApi()

      render(
        <>
          <BurstControls />
          <ActiveToastProbe />
          <NotificationsOverlay />
        </>,
        { wrapper }
      )

      fireEvent.click(screen.getByRole("button", { name: "Fire five errors" }))
      expect(screen.getByTestId("active-toast").textContent).toBe("burst 1")

      // Each error carries an 8s turn of its own. Serving all five in full left the last of them
      // 32s out, which is the measurement in the audit; only the second would be up by now.
      tick(8_500)
      expect(screen.getByTestId("active-toast").textContent).toBe("burst 5")
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives the last of a burst its whole turn, since nothing is waiting behind it", () => {
    vi.useFakeTimers()
    try {
      installMockWindowApi()

      render(
        <>
          <BurstControls />
          <ActiveToastProbe />
          <NotificationsOverlay />
        </>,
        { wrapper }
      )

      fireEvent.click(screen.getByRole("button", { name: "Fire five errors" }))

      tick(15_000)
      expect(screen.getByTestId("active-toast").textContent).toBe("burst 5")
      tick(1_500)
      expect(screen.getByTestId("active-toast").textContent).toBe("none")
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives a toast with an empty queue behind it its whole turn", () => {
    vi.useFakeTimers()
    try {
      installMockWindowApi()

      render(
        <>
          <Controls />
          <ActiveToastProbe />
          <NotificationsOverlay />
        </>,
        { wrapper }
      )

      fireEvent.click(screen.getByRole("button", { name: "Add error" }))

      act(() => vi.advanceTimersByTime(7_000))
      expect(screen.getByTestId("active-toast").textContent).toBe("Something went wrong")
      act(() => vi.advanceTimersByTime(1_500))
      expect(screen.getByTestId("active-toast").textContent).toBe("none")
    } finally {
      vi.useRealTimers()
    }
  })

  it("holds the countdown while the pointer is over the toast", () => {
    vi.useFakeTimers()
    try {
      installMockWindowApi()

      render(
        <>
          <Controls />
          <ActiveToastProbe />
          <NotificationsOverlay />
        </>,
        { wrapper }
      )

      fireEvent.click(screen.getByRole("button", { name: "Add success" }))
      fireEvent.mouseEnter(toast())
      act(() => vi.advanceTimersByTime(30_000))
      expect(screen.getByTestId("active-toast").textContent).toBe("A successful action")

      fireEvent.mouseLeave(toast())
      act(() => vi.advanceTimersByTime(5_000))
      expect(screen.getByTestId("active-toast").textContent).toBe("none")
    } finally {
      vi.useRealTimers()
    }
  })

  it("holds the countdown while focus is inside the toast, for a player who tabbed to its buttons", () => {
    vi.useFakeTimers()
    try {
      installMockWindowApi()

      render(
        <>
          <Controls />
          <ActiveToastProbe />
          <NotificationsOverlay />
        </>,
        { wrapper }
      )

      fireEvent.click(screen.getByRole("button", { name: "Add success" }))
      fireEvent.focus(screen.getByRole("button", { name: "Discard notification" }))

      act(() => vi.advanceTimersByTime(30_000))
      expect(screen.getByTestId("active-toast").textContent).toBe("A successful action")
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not park a dropped toast in the record list where it can never be shown", () => {
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => {
      for (let index = 0; index < 40; index += 1) result.current.addNotification("toast " + index, "success", { presentation: "toast" })
    })

    expect(result.current.notifications.length + result.current.history.length).toBeLessThan(40)
  })
})

describe("Activity Center keyboard reach", () => {
  it("moves focus into the panel on open, because it is portalled away from the trigger", () => {
    installMockWindowApi()

    render(<ActivityCenter />, { wrapper })
    openCenter()

    expect(panel().contains(document.activeElement)).toBe(true)
  })

  it("closes on Escape and hands focus back to the trigger", async () => {
    installMockWindowApi()

    render(<ActivityCenter />, { wrapper })
    openCenter()
    fireEvent.keyDown(panel(), { key: "Escape" })

    await waitFor(() => expect(screen.queryByRole("region", { name: "Activity Center" })).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Activity Center:/ }))
  })
})

describe("Activity Center section order", () => {
  it("puts the section a player has to act on above the one they can only watch", async () => {
    installMockWindowApi({
      pathsManager: {
        downloadOnPath: vi.fn((_id: string, url: string) => (url.endsWith("boom") ? Promise.reject(new Error("the transfer died")) : new Promise<string>(() => {})))
      }
    })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Start task" }))
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Start failing task" })))
    openCenter()

    const headings = within(panel())
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent)
    expect(headings).toEqual(["Needs attention", "In progress", "Notifications"])
  })
})

function ProbeRemoveSecond(): JSX.Element {
  const { history, removeNotification } = useNotificationsContext()
  return <button onClick={() => history[1] && removeNotification(history[1].id)}>Remove second</button>
}
