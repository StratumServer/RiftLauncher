import type { ReactElement, ReactNode } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"

import "@renderer/i18n"

/**
 * Pins where the toast region sits and what it lets through.
 *
 * The beta.10 test found the region painted over the right-hand end of every page's sticky menu:
 * "Select Mods to install together" and "Go to top" took no clicks at all while a banner was up,
 * and a banner carrying actions never times out, so they stayed dead until it was discarded. Two
 * rules come out of that, and both are here. The region itself is transparent to the pointer, so
 * an empty region blocks nothing. And it is anchored to the bottom of the main area, away from the
 * sticky menus and selection bars, which in this app all sit at the top of their column.
 *
 * A third came with #624: an open dialog hides the application's root from assistive technology and
 * from the pointer, and the banners are where a dialog's failures are reported, so they live in the
 * body beside the root and not inside it. popupDialogInert.test.tsx holds the behaviour; the
 * placement it rests on is pinned here.
 */

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <NotificationsProvider>{children}</NotificationsProvider>
}

function Controls(): JSX.Element {
  const { addNotification, toastPaused } = useNotificationsContext()

  return (
    <>
      <button onClick={() => addNotification("Only a toast", "info", { presentation: "toast" })}>Add toast</button>
      <button onClick={() => addNotification("A Mod has an update available", "info", { actions: [{ id: "view", label: "View updates" }] })}>Add actionable</button>
      <span data-testid="toast-paused">{String(toastPaused)}</span>
    </>
  )
}

function renderOverlay(): void {
  installMockWindowApi()

  render(
    <>
      <Controls />
      <NotificationsOverlay />
    </>,
    { wrapper }
  )
}

function region(): HTMLElement {
  return screen.getByRole("status")
}

describe("notifications overlay placement", () => {
  it("leaves the pointer alone where it has nothing to show", () => {
    renderOverlay()

    expect(region().className).toContain("pointer-events-none")
  })

  it("sits at the bottom of the main area, clear of the sticky menus", () => {
    renderOverlay()

    expect(region().className).toContain("bottom-2")
    expect(region().className).not.toContain("top-2")
  })

  it("sits in the body, outside whatever renders it, so a dialog hiding the application leaves it alone", () => {
    renderOverlay()

    expect(region().parentElement).toBe(document.body)
  })

  it("is fixed to the window and not selectable, which the application's root used to give it", () => {
    renderOverlay()

    // Fixed so a banner sliding in from the right cannot widen the page while it is off screen, and
    // select-none because the root's no longer reaches a region that is not inside it.
    expect(region().className).toContain("fixed")
    expect(region().className).toContain("select-none")
  })

  it("takes clicks on the banner itself", async () => {
    renderOverlay()

    fireEvent.click(screen.getByRole("button", { name: "Add toast" }))

    const card = (await screen.findByText("Only a toast")).closest("div.pointer-events-auto")

    expect(card).not.toBeNull()
    expect(region().contains(card)).toBe(true)
  })

  it("still hands keyboard focus to a banner action, and pauses for it", async () => {
    renderOverlay()

    fireEvent.click(screen.getByRole("button", { name: "Add actionable" }))

    const action = await screen.findByRole("button", { name: "View updates" })
    fireEvent.focus(action, { bubbles: true })
    action.focus()

    expect(document.activeElement).toBe(action)
    await waitFor(() => expect(screen.getByTestId("toast-paused").textContent).toBe("true"))
  })
})
