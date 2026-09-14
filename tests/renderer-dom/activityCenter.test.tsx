import type { ReactElement, ReactNode } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { MAX_TOAST_BACKLOG, MAX_VISIBLE_TOASTS } from "@domain/notifications/toastQueue"
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
      <button onClick={() => addNotification("A fourth message", "info")}>Add fourth</button>
      <button onClick={() => addNotification("A fifth message", "info")}>Add fifth</button>
      <button onClick={() => addNotification("A quiet centered notice", "info", { presentation: "center" })}>Add centered notice</button>
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

/** Exposes the stack so timer behaviour is read off state, not the DOM. `active-toast` is its newest banner. */
function ActiveToastProbe(): JSX.Element {
  const { activeToast, activeToasts, toastPaused } = useNotificationsContext()
  return (
    <>
      <span data-testid="active-toast">{activeToast?.body ?? "none"}</span>
      <span data-testid="toast-stack">{activeToasts.map((entry) => entry.record.body).join(" | ") || "none"}</span>
      <span data-testid="toast-paused">{String(toastPaused)}</span>
    </>
  )
}

/** The bodies on screen right now, oldest first. */
function stack(): string[] {
  const shown = screen.getByTestId("toast-stack").textContent ?? "none"
  return shown === "none" ? [] : shown.split(" | ")
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
    fireEvent.click(screen.getByRole("button", { name: "Add fourth" }))

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
    expect(result.current.activeToasts[0]?.record.body).toBe("being read")

    act(() => {
      for (let index = 0; index < MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS; index += 1) result.current.addNotification(`burst ${index}`, "info", { presentation: "toast" })
    })

    expect(result.current.activeToasts[0]?.record.body).toBe("being read")
  })

  it("keeps a both-presentation toast on screen when center history overflows behind it", () => {
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => result.current.addNotification("being read", "info"))
    expect(result.current.activeToasts[0]?.record.body).toBe("being read")

    act(() => {
      for (let index = 0; index < 50; index += 1) result.current.addNotification(`center ${index}`, "info", { presentation: "center" })
    })

    expect(result.current.activeToasts[0]?.record.body).toBe("being read")
    expect(result.current.history).toHaveLength(51)
  })

  it("lets only a full backlog wait behind a full stack, not one more", () => {
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => result.current.addNotification("being read", "info"))
    act(() => {
      for (let index = 0; index < MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS; index += 1) result.current.addNotification(`burst ${index}`, "info", { presentation: "toast" })
    })

    // Three banners up at once, and the oldest arrival of the burst is the one the cap dropped.
    expect(result.current.activeToasts.map((entry) => entry.record.body)).toEqual(["being read", "burst 1", "burst 2"])

    const shown: string[] = []
    for (let turns = 0; turns < MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS + 2 && result.current.activeToasts.length > 0; turns += 1) {
      const head = result.current.activeToasts[0]!.record
      shown.push(head.body)
      act(() => result.current.dismissToast(head.id))
    }

    expect(shown).toEqual(["being read", "burst 1", "burst 2", "burst 3", "burst 4", "burst 5", "burst 6"])
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
        <ActiveToastProbe />
        <ProbeRemoveLast />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    // Three fill the stack, so the fourth is still waiting when it is taken away.
    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Add success" }))
    fireEvent.click(screen.getByRole("button", { name: "Add error" }))
    fireEvent.click(screen.getByRole("button", { name: "Add fourth" }))
    expect(stack()).toEqual(["A notification worth keeping", "A successful action", "Something went wrong"])

    fireEvent.click(screen.getByRole("button", { name: "Remove last" }))
    fireEvent.click(screen.getAllByRole("button", { name: "Discard notification" })[0]!)

    expect(stack()).toEqual(["A successful action", "Something went wrong"])
  })
})

describe("toast hand-off when the banner's record disappears", () => {
  it("hands the screen to the next toast when the banner's record is cleared from the center", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Add success" }))
    fireEvent.click(screen.getByRole("button", { name: "Add error" }))
    fireEvent.click(screen.getByRole("button", { name: "Add fourth" }))
    expect(stack()).toEqual(["A notification worth keeping", "A successful action", "Something went wrong"])

    openCenter()
    const bannerRow = within(panel()).getByText("A notification worth keeping").closest("li") as HTMLElement
    fireEvent.click(within(bannerRow).getByRole("button", { name: "Mark as read" }))
    fireEvent.click(within(panel()).getByRole("button", { name: "Clear read" }))

    // The banner's record is gone but the stack still named it. Its place must not stay
    // taken by a dead id: the fourth message waiting behind it comes up at once.
    expect(stack()).toEqual(["A successful action", "Something went wrong", "A fourth message"])
  })

  it("leaves the overlay cleanly empty, not stuck, when the last record behind the banner goes", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    openCenter()
    fireEvent.click(within(panel()).getByRole("button", { name: "Mark as read" }))
    fireEvent.click(within(panel()).getByRole("button", { name: "Clear read" }))

    // The stack no longer names anything, so the overlay has no live banner.
    expect(stack()).toEqual([])

    // And the hand-off is not blocked on the dead id: the next notification still reaches the screen.
    fireEvent.click(screen.getByRole("button", { name: "Add error" }))
    expect(screen.getByTestId("active-toast").textContent).toBe("Something went wrong")
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
      // Three at once, so the first three of the burst are read side by side rather than in turn.
      expect(stack()).toEqual(["burst 1", "burst 2", "burst 3"])

      // Each error carries an 8s turn of its own. Serving all five in turn left the last of them
      // 32s out, which is the measurement in the audit; only the second would be up by now.
      tick(2_500)
      expect(stack()).toEqual(["burst 4", "burst 5"])
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

      // The last two take the screen at 2s with nothing behind them, so they get the whole 8s.
      tick(9_500)
      expect(stack()).toEqual(["burst 4", "burst 5"])
      tick(1_000)
      expect(stack()).toEqual([])
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

  it("shortens the banner on screen when something arrives behind it, instead of leaving its full turn", () => {
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

      // An 8s error takes a place with nothing behind it, so it gets its whole turn. Two more
      // join it in the stack, which is not a backlog: nothing is waiting yet.
      fireEvent.click(screen.getByRole("button", { name: "Add error" }))
      fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
      fireEvent.click(screen.getByRole("button", { name: "Add success" }))
      act(() => vi.advanceTimersByTime(400))
      // Now the stack is full and something lands behind it. Every turn drops to the backlog
      // turn from this moment (2s), not the 8s the error was handed. Before this change it
      // kept the full eight, so the error would still be up at 7s.
      fireEvent.click(screen.getByRole("button", { name: "Add fourth" }))

      act(() => vi.advanceTimersByTime(1_600))
      expect(stack()).toContain("Something went wrong")
      act(() => vi.advanceTimersByTime(600))
      expect(stack()).not.toContain("Something went wrong")
      expect(stack()).toContain("A fourth message")
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves a question on screen when something arrives behind it", () => {
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

      fireEvent.click(screen.getByRole("button", { name: "Add actionable warning" }))
      fireEvent.click(screen.getByRole("button", { name: "Add error" }))
      fireEvent.click(screen.getByRole("button", { name: "Add success" }))
      fireEvent.click(screen.getByRole("button", { name: "Add fourth" }))

      tick(30_000)
      expect(stack()).toEqual(["A decision is required"])
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

  it("keeps the countdown held when the next banner takes the screen under the same pointer", () => {
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
      fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
      // Pointer settles over the region and never moves again.
      fireEvent.mouseEnter(screen.getByRole("status"))
      // The first banner is dismissed and the one below slides up into its place. The pointer
      // is still there and has named no banner since, so the stack is held rather than running
      // its timers unseen (#398).
      fireEvent.click(screen.getAllByRole("button", { name: "Discard notification" })[0]!)
      expect(stack()).toEqual(["A notification worth keeping"])

      act(() => vi.advanceTimersByTime(30_000))
      expect(stack()).toEqual(["A notification worth keeping"])

      fireEvent.mouseLeave(screen.getByRole("status"))
      act(() => vi.advanceTimersByTime(5_000))
      expect(stack()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not shorten a banner the pointer is holding when something arrives behind it", () => {
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
      fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
      fireEvent.click(screen.getByRole("button", { name: "Add success" }))
      fireEvent.mouseEnter(screen.getByRole("status"))
      fireEvent.click(screen.getByRole("button", { name: "Add fourth" }))

      // The shortening effect is gated on each banner's own pause flag, so a held stack keeps its turns.
      act(() => vi.advanceTimersByTime(30_000))
      expect(stack()).toContain("Something went wrong")
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

  it("resumes the queue when a focused banner is dismissed", () => {
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
      fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
      const discard = screen.getAllByRole("button", { name: "Discard notification" })[0]!
      discard.focus()
      expect(document.activeElement).toBe(discard)

      fireEvent.click(discard)
      expect(stack()).toEqual(["A notification worth keeping"])
      expect(screen.getByTestId("toast-paused").textContent).toBe("false")

      act(() => vi.advanceTimersByTime(5_000))
      expect(stack()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("resumes the queue after answering a focused question", () => {
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

      fireEvent.click(screen.getByRole("button", { name: "Add actionable warning" }))
      fireEvent.click(screen.getByRole("button", { name: "Add error" }))
      const resolve = screen.getByRole("button", { name: "Resolve" })
      resolve.focus()
      expect(document.activeElement).toBe(resolve)

      fireEvent.click(resolve)
      expect(screen.getByTestId("active-toast").textContent).toBe("Something went wrong")
      expect(screen.getByTestId("toast-paused").textContent).toBe("false")

      act(() => vi.advanceTimersByTime(8_500))
      expect(screen.getByTestId("active-toast").textContent).toBe("none")
    } finally {
      vi.useRealTimers()
    }
  })

  it("shortens an active banner using its remaining time, not a fresh turn", async () => {
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
      fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
      fireEvent.click(screen.getByRole("button", { name: "Add success" }))
      act(() => vi.advanceTimersByTime(7_000))
      fireEvent.click(screen.getByRole("button", { name: "Add fourth" }))

      expect(screen.getByTestId("toast-paused").textContent).toBe("false")
      await act(async () => {
        await Promise.resolve()
      })
      // One second left of the error's eight, and the backlog turn is two: it keeps the one it
      // has rather than being handed a fresh two.
      act(() => vi.advanceTimersByTime(1_100))
      expect(stack()).toEqual(["A fourth message"])
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

/**
 * The stack itself (#389). One banner at a time meant a burst could only be read by shortening
 * every turn in it; three places let a burst of three be read side by side.
 */
describe("toast stack", () => {
  it("shows up to three banners at once, newest at the bottom, and queues the rest", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <ActiveToastProbe />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Add success" }))
    fireEvent.click(screen.getByRole("button", { name: "Add error" }))
    fireEvent.click(screen.getByRole("button", { name: "Add fourth" }))

    expect(stack()).toHaveLength(MAX_VISIBLE_TOASTS)
    expect(stack()).toEqual(["A notification worth keeping", "A successful action", "Something went wrong"])
    expect(screen.queryByText("A fourth message")).toBeNull()

    // Drawn in that order too, so the newest is the one nearest the bottom right corner.
    const banners = Array.from(screen.getByRole("status").querySelectorAll("[data-toast-id]"))
    expect(banners.map((banner) => banner.textContent)).toEqual([
      expect.stringContaining("A notification worth keeping"),
      expect.stringContaining("A successful action"),
      expect.stringContaining("Something went wrong")
    ])
  })

  it("gives each banner its own countdown bar rather than one for the stack", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Add success" }))

    expect(screen.getAllByTestId("toast-timer")).toHaveLength(2)
  })

  it("holds only the banner the pointer is on, and lets the others beside it run out", () => {
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
      fireEvent.click(screen.getByRole("button", { name: "Add notification" }))

      // The pointer settles on the error, which is the banner drawn first.
      fireEvent.mouseOver(screen.getByRole("status").querySelector("[data-toast-id]") as HTMLElement)

      act(() => vi.advanceTimersByTime(30_000))
      expect(stack()).toEqual(["Something went wrong"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("puts every banner in the stack in tab order, so a keyboard player reaches all three", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    fireEvent.click(screen.getByRole("button", { name: "Add success" }))
    fireEvent.click(screen.getByRole("button", { name: "Add error" }))

    const discards = screen.getAllByRole("button", { name: "Discard notification" })
    expect(discards).toHaveLength(MAX_VISIBLE_TOASTS)
    for (const discard of discards) expect(discard.getAttribute("tabindex")).not.toBe("-1")
  })

  it("never times out a banner carrying a question, whatever else shares the stack with it", () => {
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

      fireEvent.click(screen.getByRole("button", { name: "Add actionable warning" }))
      fireEvent.click(screen.getByRole("button", { name: "Add success" }))

      tick(30_000)
      expect(stack()).toEqual(["A decision is required"])
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * #392: the panel could only be emptied one row at a time, while the notification half right
 * below it already had "Mark all read" and "Clear read".
 */
describe("Clear all empties the centre in one action", () => {
  async function renderWithFinishedWork(): Promise<void> {
    installMockWindowApi({
      pathsManager: {
        downloadOnPath: vi.fn((_id: string, url: string) => (url.endsWith("boom") ? Promise.reject(new Error("the transfer died")) : Promise.resolve("/tmp/file.zip")))
      }
    })

    render(
      <>
        <Controls />
        <ActiveToastProbe />
        <NotificationsOverlay />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Start task" })))
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Start failing task" })))
    fireEvent.click(screen.getByRole("button", { name: "Add centered notice" }))
  }

  it("takes every finished row and every message, and offers one way back", async () => {
    await renderWithFinishedWork()
    openCenter()

    expect(within(panel()).getByText("Example download")).toBeTruthy()
    expect(within(panel()).getByText("Doomed download")).toBeTruthy()
    expect(within(panel()).getByText("A quiet centered notice")).toBeTruthy()

    fireEvent.click(within(panel()).getByRole("button", { name: "Clear all" }))

    expect(within(panel()).queryByText("Example download")).toBeNull()
    expect(within(panel()).queryByText("Doomed download")).toBeNull()
    expect(within(panel()).queryByText("A quiet centered notice")).toBeNull()
    expect(within(panel()).getByText("No activity right now.")).toBeTruthy()

    // And the way back is a banner, not a dialog the player has to answer before they can go on.
    expect(stack()).toContain("Cleared the Activity Center.")
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))

    expect(within(panel()).getByText("Example download")).toBeTruthy()
    expect(within(panel()).getByText("Doomed download")).toBeTruthy()
    expect(within(panel()).getByText("A quiet centered notice")).toBeTruthy()
  })

  it("leaves the banner on screen alone, because it is being read right now", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
    openCenter()
    fireEvent.click(within(panel()).getByRole("button", { name: "Clear all" }))

    expect(stack()).toContain("A notification worth keeping")
    expect(within(panel()).getByText("A notification worth keeping")).toBeTruthy()
  })

  it("leaves a question that has not been answered, the way Clear read already does", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Add actionable warning" }))
    fireEvent.click(screen.getByRole("button", { name: "Add centered notice" }))
    // Discarded, so the question is only a row in the centre: being on screen is not what saves it.
    fireEvent.click(screen.getAllByRole("button", { name: "Discard notification" })[0]!)
    openCenter()
    fireEvent.click(within(panel()).getByRole("button", { name: "Clear all" }))

    expect(within(panel()).getByText("A decision is required")).toBeTruthy()
    expect(within(panel()).getByRole("button", { name: "Resolve" })).toBeTruthy()
    expect(within(panel()).queryByText("A quiet centered notice")).toBeNull()
  })

  it("leaves work that is still running, since there is no way to put a live task back", () => {
    installMockWindowApi({ pathsManager: { downloadOnPath: vi.fn(() => new Promise<string>(() => {})) } })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Start task" }))
    fireEvent.click(screen.getByRole("button", { name: "Add centered notice" }))
    openCenter()
    fireEvent.click(within(panel()).getByRole("button", { name: "Clear all" }))

    expect(within(panel()).getByText("Example download")).toBeTruthy()
    expect(within(panel()).queryByText("A quiet centered notice")).toBeNull()
  })

  it("takes the toasts still waiting behind the stack, and puts them back on undo", () => {
    installMockWindowApi()
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => {
      for (const body of ["first", "second", "third", "waiting"]) result.current.addNotification(body, "info", { presentation: "toast" })
    })
    expect(result.current.activeToasts.map((entry) => entry.record.body)).toEqual(["first", "second", "third"])

    let undo: () => void = () => {}
    act(() => {
      undo = result.current.clearAllNotifications()
    })
    // The three on screen stay; only the one still queued is taken.
    expect(result.current.activeToasts.map((entry) => entry.record.body)).toEqual(["first", "second", "third"])

    act(() => result.current.dismissToast(result.current.activeToasts[0]!.record.id))
    expect(result.current.activeToasts.map((entry) => entry.record.body)).toEqual(["second", "third"])

    act(() => undo())
    expect(result.current.activeToasts.map((entry) => entry.record.body)).toEqual(["second", "third", "waiting"])
  })

  /** Found on the packaged build: the undo belongs to the press that raised it and to no other. */
  it("does not let an undo bring back what an earlier clear took", () => {
    installMockWindowApi()
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => result.current.addNotification("from the first clear", "info", { presentation: "center" }))
    let undoFirst: () => void = () => {}
    act(() => {
      undoFirst = result.current.clearAllNotifications()
    })
    expect(result.current.history).toHaveLength(0)

    // A second clear with nothing left to take, and then an undo of that one.
    let undo: () => void = () => {}
    act(() => {
      undo = result.current.clearAllNotifications()
    })
    act(() => undo())
    expect(result.current.history).toHaveLength(0)
    act(() => undoFirst())
    expect(result.current.history).toHaveLength(1)
  })

  it("keeps each bulk-clear undo tied to the clear that raised it", () => {
    installMockWindowApi()
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => result.current.addNotification("from A", "info", { presentation: "center" }))
    let undoA: () => void = () => {}
    act(() => {
      undoA = result.current.clearAllNotifications()
    })
    act(() => result.current.addNotification("from B", "info", { presentation: "center" }))
    let undoB: () => void = () => {}
    act(() => {
      undoB = result.current.clearAllNotifications()
    })

    act(() => undoA())
    expect(result.current.history.map((entry) => entry.body)).toEqual(["from A"])
    act(() => undoB())
    expect(result.current.history.map((entry) => entry.body)).toEqual(["from A", "from B"])
  })

  it("offers nothing to clear when there is nothing there", () => {
    installMockWindowApi()

    render(<ActivityCenter />, { wrapper })
    openCenter()

    expect(within(panel()).queryByRole("button", { name: "Clear all" })).toBeNull()
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

/**
 * #390: a failed row said "This task stopped before it finished" for every failure it could
 * possibly show, while the thing that failed knew perfectly well why.
 */
/**
 * #391: toggling a mod off and straight back on, or a retry that fails the same way twice, put
 * the same sentence on screen twice and spent two of the stack's three places on one word.
 */
describe("a repeated message folds into the banner already up", () => {
  it("keeps one banner, wearing the count, instead of two saying the same thing", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Add error" }))

    expect(stack()).toEqual(["Something went wrong"])
    expect(screen.getAllByRole("button", { name: "Discard notification" })).toHaveLength(1)
    expect(screen.getByText("x2")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Add error" }))
    expect(screen.getByText("x3")).toBeTruthy()
  })

  it("wears no count at all the first time a message arrives", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add error" }))
    expect(screen.queryByText(/^x\d+$/)).toBeNull()
  })

  it("gives the banner a fresh turn, because the repeat arrived just now", () => {
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
      act(() => vi.advanceTimersByTime(4_000))
      fireEvent.click(screen.getByRole("button", { name: "Add success" }))

      // Without the restart the fold would have swallowed the second message and let the banner
      // go at 4.5s, half a second after the player was told about it.
      act(() => vi.advanceTimersByTime(3_000))
      expect(stack()).toEqual(["A successful action"])
      act(() => vi.advanceTimersByTime(2_000))
      expect(stack()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("folds into one still waiting behind a full stack rather than queueing it twice", () => {
    installMockWindowApi()
    const { result } = renderHook(() => useNotificationsContext(), { wrapper })

    act(() => {
      for (const body of ["first", "second", "third"]) result.current.addNotification(body, "info")
      result.current.addNotification("waiting", "info")
      result.current.addNotification("waiting", "info")
    })

    // Three on screen and one waiting, which is the one record the two identical adds made.
    expect(result.current.activeToasts.map((entry) => entry.record.body)).toEqual(["first", "second", "third"])
    expect(result.current.history.map((record) => record.body)).toEqual(["first", "second", "third", "waiting"])
    expect(result.current.history.at(-1)?.repeats).toBe(2)

    act(() => result.current.dismissToast(result.current.activeToasts[0]!.record.id))
    expect(result.current.activeToasts.map((entry) => entry.record.body)).toEqual(["second", "third", "waiting"])
  })

  it("never folds a question, because two questions are two answers owed", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <ActiveToastProbe />
        <NotificationsOverlay />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add actionable warning" }))
    fireEvent.click(screen.getByRole("button", { name: "Add actionable warning" }))

    expect(stack()).toEqual(["A decision is required", "A decision is required"])
    expect(screen.getAllByRole("button", { name: "Resolve" })).toHaveLength(2)
  })

  it("keeps both entries in the center, which is history and is meant to hold them", () => {
    installMockWindowApi()

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Add centered notice" }))
    fireEvent.click(screen.getByRole("button", { name: "Add centered notice" }))
    openCenter()

    expect(within(panel()).getAllByText("A quiet centered notice")).toHaveLength(2)
  })
})

describe("a failed row names its cause", () => {
  it("says the connection failed on a download the network killed, and repeats it on the message", async () => {
    installMockWindowApi({
      pathsManager: {
        downloadOnPath: vi.fn(() => Promise.reject(new Error("Error invoking remote method 'downloadOnPath': Error: connect ECONNREFUSED 127.0.0.1:443")))
      }
    })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Start task" })))
    openCenter()

    const row = within(panel()).getByText("Example download").closest("li") as HTMLElement
    expect(within(row).getByText("The connection failed. Check your connection or firewall, then try again.")).toBeTruthy()
    expect(within(row).queryByText("This task stopped before it finished. The log has the details.")).toBeNull()

    // The message the task runner raised carries the same token, so its row says the same thing.
    const messageRow = within(panel()).getByText("Couldn't download Example download. Check your connection and try again.").closest("li") as HTMLElement
    expect(within(messageRow).getByText("The connection failed. Check your connection or firewall, then try again.")).toBeTruthy()
  })

  it("says the drive is full when that is what stopped it", async () => {
    installMockWindowApi({
      pathsManager: { downloadOnPath: vi.fn(() => Promise.reject(new Error("ENOSPC: no space left on device, write"))) }
    })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Start task" })))
    openCenter()

    const row = within(panel()).getByText("Example download").closest("li") as HTMLElement
    expect(within(row).getByText("The drive has no room left. Free some space, then try again.")).toBeTruthy()
  })

  it("keeps the old sentence for a failure it cannot place, rather than guessing at one", async () => {
    installMockWindowApi({
      pathsManager: { downloadOnPath: vi.fn(() => Promise.reject(new Error("the transfer died"))) }
    })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Start task" })))
    openCenter()

    const row = within(panel()).getByText("Example download").closest("li") as HTMLElement
    expect(within(row).getByText("This task stopped before it finished. The log has the details.")).toBeTruthy()
  })

  it("never puts the error's own words on a row", async () => {
    installMockWindowApi({
      pathsManager: { downloadOnPath: vi.fn(() => Promise.reject(new Error("EACCES: permission denied, open '/home/someone/Vintage Story/mods'"))) }
    })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Start task" })))
    openCenter()

    expect(within(panel()).getAllByText("RiftLauncher is not allowed to write there. Check that folder's permissions, then try again.")).toHaveLength(2)
    expect(panel().textContent).not.toContain("/home/someone")
    expect(panel().textContent).not.toContain("EACCES")
  })

  it("leaves the row of a task that is still running without a cause line", async () => {
    installMockWindowApi({ pathsManager: { downloadOnPath: vi.fn(() => new Promise<string>(() => {})) } })

    render(
      <>
        <Controls />
        <ActivityCenter />
      </>,
      { wrapper }
    )

    fireEvent.click(screen.getByRole("button", { name: "Start task" }))
    openCenter()

    const row = within(panel()).getByText("Example download").closest("li") as HTMLElement
    expect(within(row).queryByText(/Check your connection or firewall/)).toBeNull()
    expect(within(row).queryByText("This task stopped before it finished. The log has the details.")).toBeNull()
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

describe("toast queue pointer handoff", () => {
  it("lets the next toast finish after the pointer leaves a dismissed banner through the document listener", async () => {
    vi.useFakeTimers()
    try {
      installMockWindowApi()

      render(
        <>
          <Controls />
          <ActiveToastProbe />
          <NotificationsOverlay />
          <button data-testid="outside-toast-region">Outside toast region</button>
        </>,
        { wrapper }
      )

      fireEvent.click(screen.getByRole("button", { name: "Add error" }))
      fireEvent.click(screen.getByRole("button", { name: "Add notification" }))
      fireEvent.mouseOver(toast())
      fireEvent.click(screen.getAllByRole("button", { name: "Discard notification" })[0]!)

      expect(stack()).toEqual(["A notification worth keeping"])

      fireEvent.mouseOver(screen.getByTestId("outside-toast-region"))
      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId("toast-paused").textContent).toBe("false")
      act(() => vi.advanceTimersByTime(4_500))
      expect(stack()).toEqual([])
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

function ProbeRemoveLast(): JSX.Element {
  const { history, removeNotification } = useNotificationsContext()
  return <button onClick={() => history.at(-1) && removeNotification(history.at(-1)!.id)}>Remove last</button>
}
