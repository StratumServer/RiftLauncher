import type { ReactElement, ReactNode } from "react"
import { flushSync } from "react-dom"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import type { PresentedToast } from "@renderer/contexts/NotificationsContext"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"

import "@renderer/i18n"

/**
 * #613: flipping a Config switch whose notice says "takes effect the next time" twice in a row put
 * one record in the stack twice, and with another banner waiting one copy stayed on screen with a
 * close button that did nothing.
 *
 * The second flip only folds into the record the first one made, and that re-runs the hand-off
 * effect. A click renders at once, ahead of the update the first run of that effect had queued, so
 * the effect saw the queue and the stack from before its own first run and admitted the id again.
 * fireEvent cannot show it, because each act() settles every pending update before the next click.
 * flushSync inside a single act() is a click that renders while the earlier hand-off still waits.
 */
const SWITCH_NOTICE = "This setting takes effect the next time RiftLauncher starts."
const PINNED_NOTICE = "A notice that does not expire"
const LAST_MESSAGE = "Another message"

let liveToasts: readonly PresentedToast[] = []

function ToastProbe(): null {
  liveToasts = useNotificationsContext().activeToasts
  return null
}

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <NotificationsProvider>{children}</NotificationsProvider>
}

function Controls(): JSX.Element {
  const { addNotification } = useNotificationsContext()

  return (
    <>
      <button onClick={() => addNotification(SWITCH_NOTICE, "info")}>Flip switch</button>
      <button onClick={() => addNotification(PINNED_NOTICE, "warning", { duration: null })}>Add pinned</button>
      <button onClick={() => addNotification(LAST_MESSAGE, "error")}>Add last</button>
    </>
  )
}

function renderBanners(): void {
  installMockWindowApi()

  render(
    <>
      <Controls />
      <ToastProbe />
      <NotificationsOverlay />
    </>,
    { wrapper }
  )
}

/** What each banner in the document shows, so a copy that outlived its record is still counted. */
function bannerTexts(): string[] {
  return Array.from(screen.getByRole("status").querySelectorAll("[data-toast-id]"), (banner) => banner.querySelector("p")?.firstChild?.textContent ?? "")
}

/** The close button of the first banner showing `text`. */
function closeButtonOf(text: string): HTMLElement {
  const banner = screen.getAllByText(text)[0]?.closest("[data-toast-id]") as HTMLElement
  return within(banner).getByRole("button", { name: "Discard notification" })
}

/** Two clicks on the switch, the second landing while the first one's hand-off to the stack is still pending. */
function flipTwiceBeforeTheHandOff(): void {
  const flip = screen.getByRole("button", { name: "Flip switch" })

  act(() => {
    flushSync(() => flip.click())
    // Queued and not up yet: the window the second flip has to land in.
    expect(screen.queryByText(SWITCH_NOTICE)).toBeNull()
    flushSync(() => flip.click())
  })
}

describe("a repeat that lands before the first hand-off has applied (#613)", () => {
  it("takes one place in the stack, not two", () => {
    renderBanners()

    flipTwiceBeforeTheHandOff()

    expect(liveToasts.map((toast) => toast.record.body)).toEqual([SWITCH_NOTICE])
    expect(liveToasts[0]?.record.repeats).toBe(2)
    expect(bannerTexts()).toEqual([SWITCH_NOTICE])
  })

  it("lets every banner be closed, with another one waiting behind the pair", async () => {
    renderBanners()

    fireEvent.click(screen.getByRole("button", { name: "Add pinned" }))
    flipTwiceBeforeTheHandOff()
    fireEvent.click(screen.getByRole("button", { name: "Add last" }))

    // The two that were up first, then the one that came in behind them. The banners slide out
    // before they leave the document, so each step waits for the screen to settle.
    fireEvent.click(closeButtonOf(PINNED_NOTICE))
    fireEvent.click(closeButtonOf(SWITCH_NOTICE))
    await waitFor(() => expect(bannerTexts()).toEqual([LAST_MESSAGE]), { timeout: 5_000 })

    fireEvent.click(closeButtonOf(LAST_MESSAGE))
    await waitFor(() => expect(bannerTexts()).toEqual([]), { timeout: 5_000 })
  })
})
