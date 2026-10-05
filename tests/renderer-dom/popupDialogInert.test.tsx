import { useState } from "react"
import { Portal } from "@headlessui/react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import App from "@renderer/App"
import ConfirmDialog from "@renderer/components/ui/ConfirmDialog"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"

import { createMockConfig, installMockWindowApi, type WindowApiOverrides } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * While a dialog is open, the page behind it has to be out of reach of assistive technology, not
 * just covered (#624). Only `aria-modal` and the focus trap kept a screen reader inside a dialog
 * before, and not every screen reader honours `aria-modal`.
 *
 * Headless UI does the marking, on the top-level node that holds the application, and it does it
 * from one effect that runs when a Dialog opens. It learns which node that is one render after the
 * Dialog mounts, so a Dialog mounted already open ran the effect too early and never ran it again.
 * PopupDialogPanel mounts a fresh Dialog every time it opens, so every dialog but the first of a
 * session was left without the marking. The first one is the exception, because Headless UI holds
 * back "open" until its own first effect, so the tests here start from the state a real session is
 * in once anything has used Headless UI (the Portal in beforeAll), and a dialog is only a fair
 * test of the bug from then on.
 *
 * jsdom has neither `inert` nor the refusal to focus an inert element. Both are put in here the way
 * Chromium has them, so that "focus returns to the control that opened the dialog" is measured
 * against a page that can really refuse it.
 */
const NATIVE_FOCUS = HTMLElement.prototype.focus

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "inert", {
    configurable: true,
    get(this: HTMLElement): boolean {
      return this.hasAttribute("inert")
    },
    set(this: HTMLElement, value: boolean) {
      this.toggleAttribute("inert", Boolean(value))
    }
  })
  HTMLElement.prototype.focus = function focusUnlessInert(this: HTMLElement, options?: FocusOptions): void {
    if (this.closest("[inert]")) return
    NATIVE_FOCUS.call(this, options)
  }

  render(<Portal>already used</Portal>).unmount()
})

afterAll(() => {
  HTMLElement.prototype.focus = NATIVE_FOCUS
  Reflect.deleteProperty(HTMLElement.prototype, "inert")
})

/** The top-level node holding the application: the node Headless UI marks, `#root` in the launcher. */
function pageBehind(): HTMLElement {
  const page = document.querySelector("main")?.closest("body > *")
  if (!(page instanceof HTMLElement)) throw new Error("No page is mounted")
  return page
}

function expectPageHidden(page: HTMLElement): void {
  expect(page.getAttribute("aria-hidden")).toBe("true")
  expect(page.inert).toBe(true)
  // What a screen reader is left with: the page's landmark is gone from the tree.
  expect(screen.queryByRole("main")).toBeNull()
}

function expectPageReturned(page: HTMLElement): void {
  expect(page.hasAttribute("aria-hidden")).toBe(false)
  expect(page.inert).toBe(false)
  expect(screen.getByRole("main")).toBeTruthy()
}

const MODDB_ANSWERED: ConfigType["moddbVisibility"] = { policy: "never", answeredVersion: "", countedVersions: [] }

function renderApp(overrides: WindowApiOverrides = {}): void {
  window.location.hash = "#/"
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ moddbVisibility: MODDB_ANSWERED })) },
    ...overrides
  })
  // App builds its own HashRouter, so it is mounted without the helper's MemoryRouter.
  renderWithProviders(<App />, { route: false })
}

describe("the page behind a dialog", () => {
  it("is hidden while the dialog the launcher opens by itself is up, and comes back when it is closed", async () => {
    const user = userEvent.setup()
    // The default config has not answered the ModDB question, so the launcher asks it on its own.
    renderApp({ configManager: { getConfig: vi.fn(async () => createMockConfig()) } })

    expect(await screen.findByRole("dialog", { name: "Help other players find RiftLauncher" })).toBeTruthy()
    const page = pageBehind()
    expectPageHidden(page)

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expectPageReturned(page)
  })

  it("is hidden while a dialog opened from the page is up, and the control that opened it gets focus back", async () => {
    const user = userEvent.setup()
    renderApp()

    const trigger = await screen.findByRole("button", { name: "Log in" })
    await user.click(trigger)

    expect(await screen.findByRole("dialog", { name: "Log in to Vintage Story" })).toBeTruthy()
    const page = pageBehind()
    expectPageHidden(page)

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expectPageReturned(page)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it("is hidden again by every dialog that opens after it, not only the first", async () => {
    const user = userEvent.setup()
    renderApp()
    const trigger = await screen.findByRole("button", { name: "Log in" })

    for (let opening = 1; opening <= 3; opening++) {
      await user.click(trigger)
      expect(await screen.findByRole("dialog")).toBeTruthy()
      expectPageHidden(pageBehind())

      await user.keyboard("{Escape}")

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      expectPageReturned(pageBehind())
    }
  })
})

describe("a dialog opened over another dialog", () => {
  function Nested(): JSX.Element {
    const [outerOpen, setOuterOpen] = useState(false)
    const [innerOpen, setInnerOpen] = useState(false)

    return (
      <main>
        <h1>The page</h1>
        <button onClick={() => setOuterOpen(true)}>Open outer</button>
        <PopupDialogPanel title="Outer" isOpen={outerOpen} close={() => setOuterOpen(false)}>
          <>
            <button onClick={() => setInnerOpen(true)}>Open inner</button>
            <ConfirmDialog title="Inner" isOpen={innerOpen} close={() => setInnerOpen(false)} question="Sure?" confirmLabel="Yes" confirmIcon={null} onConfirm={() => setInnerOpen(false)} />
          </>
        </PopupDialogPanel>
      </main>
    )
  }

  it("hides the page and the dialog under it, and gives each back in turn", async () => {
    const user = userEvent.setup()
    render(<Nested />)
    const page = pageBehind()

    await user.click(screen.getByRole("button", { name: "Open outer" }))
    expect(await screen.findByRole("dialog", { name: "Outer" })).toBeTruthy()
    expectPageHidden(page)

    await user.click(screen.getByRole("button", { name: "Open inner" }))
    expect(await screen.findByRole("dialog", { name: "Inner" })).toBeTruthy()
    // Two dialogs in the document, one in reach: the outer one is behind the inner one now.
    expect(screen.queryByRole("dialog", { name: "Outer" })).toBeNull()
    expectPageHidden(page)

    await user.click(within(screen.getByRole("dialog", { name: "Inner" })).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull())
    // Back to one dialog: it is in reach again and the page is still behind it.
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy()
    expectPageHidden(page)

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expectPageReturned(page)
  })
})

describe("the notifications while a dialog is open", () => {
  it("stay in reach of a screen reader and the pointer, and discarding one leaves the dialog open", async () => {
    const user = userEvent.setup()
    renderApp({
      accountManager: {
        login: vi.fn(async () => {
          throw new Error("Login failed")
        })
      }
    })

    await user.click(await screen.findByRole("button", { name: "Log in" }))
    await user.type(await screen.findByLabelText("Email"), "steve@example.com")
    await user.type(screen.getByLabelText("Password"), "hunter2")
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Log in" }))

    // The login dialog stays open on a failure and the toast is the only place the reason is
    // given, so a toast the page's hiding took with it would leave a screen reader with nothing.
    const failure = await screen.findByRole("alert")
    expect(failure.textContent).toContain("Couldn't reach the login service")
    expect(failure.closest("[aria-hidden='true'], [inert]")).toBeNull()
    expect(screen.getByRole("status")).toBeTruthy()
    expectPageHidden(pageBehind())

    await user.click(within(failure).getByRole("button", { name: "Discard notification" }))

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    expect(screen.getByRole("dialog", { name: "Log in to Vintage Story" })).toBeTruthy()
  })
})
