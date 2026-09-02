import type { ReactElement, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import type { NotificationType } from "@renderer/contexts/NotificationsContext"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import ActivityCenter from "@renderer/components/ui/ActivityCenter"

import { installMockWindowApi } from "./helpers/windowApi"
import type { MockedBridgeAPI } from "./helpers/windowApi"

// Registers the i18n instance useTranslation() reads inside both providers,
// the same way renderWithProviders (./helpers/render) does.
import "@renderer/i18n"

/**
 * The renderer half of issues #184 and #185, mounted the way App.tsx mounts it:
 * NotificationsProvider outside TaskProvider, with the overlay that draws the
 * toasts and the menu that draws the task list both on screen.
 *
 * Fake timers, because the consent toast is deliberately held back for two
 * seconds (App.tsx's start-up loader covers the whole window for that long).
 *
 * A toast leaving is read off `liveNotifications` rather than off the DOM.
 * NotificationsOverlay wraps its toasts in AnimatePresence, whose exit
 * animation never reports itself finished while the timers are fake, so a
 * dismissed toast stays in the document as a leftover of an animation that
 * cannot end. Its removal from the notification list is the actual behavior;
 * the leftover node is a fake-timer artifact. Everything else here is asserted
 * against the DOM.
 */
let liveNotifications: NotificationType[] = []

function NotificationsProbe(): null {
  liveNotifications = useNotificationsContext().notifications
  return null
}

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <NotificationsProvider>
      <TaskProvider>{children}</TaskProvider>
    </NotificationsProvider>
  )
}

function renderUpdateSurfaces(): ReturnType<typeof render> {
  return render(
    <>
      <NotificationsProbe />
      <NotificationsOverlay />
      <ActivityCenter />
    </>,
    { wrapper }
  )
}

/**
 * `downloaded` and `error` are lists, not single callbacks: both providers
 * subscribe to each of those channels (the notification provider to offer the
 * restart and to offer a failed download again, the task provider to complete
 * or fail the task), exactly as the preload's own subscribe does, and keeping
 * only the last one to register would quietly test half of it.
 */
type Listeners = {
  updateAvailable?: UpdateAvailableCallback
  progress?: UpdateProgressCallback
  downloaded: Array<() => void>
  error: Array<() => void>
}

/** Installs a window.api whose updater subscriptions hand their callback back to the test. */
function installUpdaterApi(unsubscribe: () => void = () => {}): { api: MockedBridgeAPI; listeners: Listeners } {
  const listeners: Listeners = { downloaded: [], error: [] }

  const api = installMockWindowApi({
    appUpdater: {
      onUpdateAvailable: vi.fn((callback: UpdateAvailableCallback): Unsubscribe => {
        listeners.updateAvailable = callback
        return unsubscribe
      }),
      onUpdateDownloadProgress: vi.fn((callback: UpdateProgressCallback): Unsubscribe => {
        listeners.progress = callback
        return unsubscribe
      }),
      onUpdateDownloaded: vi.fn((callback: () => void): Unsubscribe => {
        listeners.downloaded.push(callback)
        return unsubscribe
      }),
      onUpdateError: vi.fn((callback: () => void): Unsubscribe => {
        listeners.error.push(callback)
        return unsubscribe
      })
    }
  })

  return { api, listeners }
}

/** Fires update-available and lets the toast's own two second hold elapse. */
function offerUpdate(listeners: Listeners, version = "1.7.0-beta.3"): void {
  act(() => listeners.updateAvailable?.({ version }))
  act(() => {
    vi.advanceTimersByTime(2_000)
  })
}

/** Fires update-downloaded at every provider that subscribed to it. */
function fireDownloaded(listeners: Listeners): void {
  act(() => listeners.downloaded.forEach((callback) => callback()))
}

/** Fires the updater's error event at every provider that subscribed to it. */
function fireError(listeners: Listeners): void {
  act(() => listeners.error.forEach((callback) => callback()))
}

/**
 * The accept button belonging to one particular toast, found through that
 * toast's own text. Needed because an answered toast is still in the document
 * under fake timers, with an "Update now" of its own that a plain getByRole
 * would find alongside the live one.
 */
function acceptButtonOf(body: string): HTMLElement {
  const toastText = screen.getByText(body)
  return within(toastText.parentElement as HTMLElement).getByRole("button", { name: "Update now" })
}

/** True while the update offer is still in the notification list waiting for an answer. */
function offerIsLive(): boolean {
  return liveNotifications.some((notification) => notification.body.includes("is available"))
}

/** Opens the task menu popover, which is where every task's progress bar lives. */
function openTasksMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: /active task/ }))
}

/** The task list's progress bar, or null when no task is running. */
function progressBar(): HTMLElement | null {
  return screen.queryByRole("progressbar")
}

beforeEach(() => {
  vi.useFakeTimers()
  liveNotifications = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe("the update offer (#184)", () => {
  it("asks before downloading anything, offering both an accept and a refusal", () => {
    const { api, listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    // Nothing is offered until the main process says an update exists.
    expect(screen.queryByText(/is available/)).toBeNull()

    offerUpdate(listeners)

    expect(screen.getByText("RiftLauncher 1.7.0-beta.3 is available. Do you want to download it now?")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy()
    // Merely being offered one must never start a download.
    expect(api.appUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it("asks the main process to download only once the offer is accepted", () => {
    const { api, listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)
    fireEvent.click(screen.getByRole("button", { name: "Update now" }))

    expect(api.appUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    // The offer has been answered, so it goes, and says where to watch instead.
    expect(offerIsLive()).toBe(false)
    expect(screen.queryByText("Starting download: RiftLauncher 1.7.0-beta.3!")).toBeNull()
  })

  it("can only be answered once, however fast the accept is clicked", () => {
    const { api, listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)

    // Three clicks with nothing in between, the way a double click (or an
    // impatient one) reaches the button: the toast leaves the notification
    // list on the first, but its node stays on screen for as long as the exit
    // animation runs, so all three land on a button that is still there.
    const accept = screen.getByRole("button", { name: "Update now" })
    fireEvent.click(accept)
    fireEvent.click(accept)
    fireEvent.click(accept)

    expect(api.appUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Starting download: RiftLauncher 1.7.0-beta.3!")).toBeNull()
    expect(offerIsLive()).toBe(false)
  })

  it("downloads nothing when the offer is refused, and does not ask again on its own", () => {
    const { api, listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)
    fireEvent.click(screen.getByRole("button", { name: "Not now" }))

    expect(api.appUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(offerIsLive()).toBe(false)

    // Two more minutes of the session going by bring no second prompt.
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(offerIsLive()).toBe(false)
    expect(api.appUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it("keeps an unanswered offer open until it is explicitly answered", () => {
    const { api, listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)
    expect(offerIsLive()).toBe(true)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(offerIsLive()).toBe(true)
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy()
    expect(screen.queryByTestId("toast-timer")).toBeNull()
    expect(api.appUpdater.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe("the download's progress bar (#185)", () => {
  it("creates the task from the initial zero progress before the update is downloaded", () => {
    const { api, listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)
    fireEvent.click(screen.getByRole("button", { name: "Update now" }))
    act(() => listeners.progress?.({ version: "1.7.0-beta.3", progress: 0 }))

    openTasksMenu()
    expect(screen.getByText("RiftLauncher 1.7.0-beta.3")).toBeTruthy()
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("0")

    fireDownloaded(listeners)

    expect(progressBar()).toBeNull()
    expect(api.appUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it("draws a task whose bar follows the update's progress, and completes it when the update lands", () => {
    const { listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)
    fireEvent.click(screen.getByRole("button", { name: "Update now" }))

    openTasksMenu()
    expect(screen.queryByRole("progressbar")).toBeNull()

    act(() => listeners.progress?.({ version: "1.7.0-beta.3", progress: 12 }))

    expect(screen.getByText("RiftLauncher 1.7.0-beta.3")).toBeTruthy()
    expect(screen.getByText(/Downloading/)).toBeTruthy()
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("12")

    act(() => listeners.progress?.({ version: "1.7.0-beta.3", progress: 68 }))
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("68")

    // The downloaded event is what completes the task, so a last tick under
    // 100 cannot leave the bar running for ever.
    fireDownloaded(listeners)

    expect(progressBar()).toBeNull()
    expect(screen.getByText("RiftLauncher 1.7.0-beta.3")).toBeTruthy()
  })

  it("does not complete the task on a tick of 100, only the downloaded event does (#200)", () => {
    const { listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)
    fireEvent.click(screen.getByRole("button", { name: "Update now" }))
    openTasksMenu()

    act(() => listeners.progress?.({ version: "1.7.0-beta.3", progress: 30 }))

    // 100 is what a raw 99.6 percent arrives as, since the main process rounds
    // the percentage on the way out (see toTaskProgress in tests/main). Bytes
    // are still moving here, and on Windows the installer's signature is still
    // being checked, so the bar has to stay running.
    act(() => listeners.progress?.({ version: "1.7.0-beta.3", progress: 100 }))

    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("100")
    expect(screen.queryByTitle("Discard task")).toBeNull()

    fireDownloaded(listeners)

    expect(progressBar()).toBeNull()
    expect(screen.getByTitle("Discard task")).toBeTruthy()
  })

  it("shows the restart affordance once the update is downloaded, and restarts when it is taken", () => {
    const { api, listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    fireDownloaded(listeners)
    act(() => {
      vi.advanceTimersByTime(2_000)
    })

    fireEvent.click(screen.getByRole("button", { name: "Restart and update" }))

    expect(api.appUpdater.updateAndRestart).toHaveBeenCalledTimes(1)
  })

  it("fails the task when the download errors, instead of freezing the bar where it died", () => {
    const { listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)
    fireEvent.click(screen.getByRole("button", { name: "Update now" }))

    openTasksMenu()
    act(() => listeners.progress?.({ version: "1.7.0-beta.3", progress: 47 }))
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("47")

    fireError(listeners)

    expect(progressBar()).toBeNull()
    expect(screen.getByText("An error has occurred during the process!")).toBeTruthy()
  })

  it("offers the download again when it fails, rather than leaving a red task until the next launch", () => {
    const { api, listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)
    fireEvent.click(screen.getByRole("button", { name: "Update now" }))
    expect(api.appUpdater.downloadUpdate).toHaveBeenCalledTimes(1)

    act(() => listeners.progress?.({ version: "1.7.0-beta.3", progress: 47 }))
    fireError(listeners)

    const retry = "The download of RiftLauncher 1.7.0-beta.3 failed. Do you want to try again?"
    expect(screen.getByText(retry)).toBeTruthy()

    fireEvent.click(acceptButtonOf(retry))

    expect(api.appUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it("offers nothing when the error was a failed check rather than a failed download", () => {
    const { api, listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    // An offline launch: the check itself fails before anything is offered.
    fireError(listeners)
    act(() => {
      vi.advanceTimersByTime(2_000)
    })

    expect(screen.queryByText(/Do you want to/)).toBeNull()
    expect(api.appUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it("keeps one task for the whole download, however many ticks arrive", () => {
    const { listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    offerUpdate(listeners)
    fireEvent.click(screen.getByRole("button", { name: "Update now" }))
    openTasksMenu()

    for (const progress of [3, 17, 41, 82]) {
      act(() => listeners.progress?.({ version: "1.7.0-beta.3", progress }))
    }

    expect(screen.getAllByText("RiftLauncher 1.7.0-beta.3")).toHaveLength(1)
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("82")
  })

  it("still names the task when the feed gave no version to name it with", () => {
    const { listeners } = installUpdaterApi()
    renderUpdateSurfaces()

    openTasksMenu()
    act(() => listeners.progress?.({ version: "", progress: 25 }))

    expect(screen.getByText("RiftLauncher")).toBeTruthy()
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("25")
  })

  it("unsubscribes from every updater channel when the providers unmount", () => {
    const unsubscribe = vi.fn()
    installUpdaterApi(unsubscribe)

    const { unmount } = renderUpdateSurfaces()
    unmount()

    // Three from NotificationsProvider (available, error, downloaded) and three
    // from TaskProvider (progress, downloaded, error).
    expect(unsubscribe).toHaveBeenCalledTimes(6)
  })
})
