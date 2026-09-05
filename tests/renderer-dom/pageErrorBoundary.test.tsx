import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import App from "@renderer/App"
import { installGlobalErrorLogging } from "@renderer/adapters/errorLog"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

// The page ManageMods route renders, replaced by one that throws the way beta.7's did: a
// TypeError raised on the very first render, before anything is on screen (#370).
vi.mock("@renderer/features/installations/pages/ManageMods", () => ({
  default: function ExplodingManageMods(): JSX.Element {
    throw new TypeError("Cannot read properties of null (reading 'toLowerCase')")
  }
}))

/**
 * React prints "The above error occurred in ..." through console.error for every error a
 * boundary catches. Silencing it keeps the intentional crash out of the run's output; a real
 * failure still surfaces through the assertions.
 */
function silenceReactErrorLogging(): void {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  afterEach(() => consoleError.mockRestore())
}

/** Every log line the renderer sent through the bridge at error level. */
function errorLogLines(api: MockedBridgeAPI): string[] {
  return vi
    .mocked(api.utils.logMessage)
    .mock.calls.filter(([level]) => level === "error")
    .map(([, message]) => message)
}

describe("a page that throws", () => {
  silenceReactErrorLogging()

  beforeEach(() => {
    window.location.hash = "#/installations/mods/1"
  })

  function renderApp(): MockedBridgeAPI {
    const api = installMockWindowApi({
      // "asked" keeps the ModDB visibility prompt shut: it is a modal that traps focus, which
      // would make the focus assertion below measure the dialog rather than the fallback.
      configManager: { getConfig: vi.fn(async () => createMockConfig({ moddbVisibilityAnswer: "asked" })) }
    })

    // App builds its own HashRouter, so it is mounted without the helper's MemoryRouter.
    renderWithProviders(<App />, { route: false })

    return api
  }

  it("shows the fallback in the page area while the shell stays mounted", async () => {
    renderApp()

    expect(await screen.findByRole("alert", { name: "This page couldn't be displayed" })).toBeTruthy()
    // The main menu, the session button and the activity center all live outside <main>.
    expect(screen.getByText("Manage your Installations")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy()
  })

  it("tells the player the launcher still works and where the log is", async () => {
    renderApp()

    const alert = await screen.findByRole("alert", { name: "This page couldn't be displayed" })

    expect(alert.textContent).toContain("The rest of the launcher still works")
    expect(alert.textContent).toContain("Debug info")
  })

  it("writes the error name, message and component stack to the log", async () => {
    const api = renderApp()

    await screen.findByRole("alert", { name: "This page couldn't be displayed" })

    const logged = errorLogLines(api).find((line) => line.includes("PageErrorBoundary"))
    expect(logged).toBeDefined()
    expect(logged).toContain("TypeError")
    expect(logged).toContain("Cannot read properties of null (reading 'toLowerCase')")
    expect(logged).toContain("Component stack:")
    expect(logged).toContain("ExplodingManageMods")
  })

  it("focuses the way out and navigates home when it is taken", async () => {
    const user = userEvent.setup()
    renderApp()

    const goHome = await screen.findByRole("button", { name: "Go to the main menu" })
    expect(document.activeElement).toBe(goHome)

    await user.click(goHome)

    // The real home page, rendered where the fallback was.
    expect(await screen.findByRole("heading", { name: "Welcome to RiftLauncher" })).toBeTruthy()
    expect(screen.queryByRole("alert", { name: "This page couldn't be displayed" })).toBeNull()
  })
})

describe("global error listeners", () => {
  let api: MockedBridgeAPI
  let uninstall: () => void

  beforeEach(() => {
    api = installMockWindowApi()
    uninstall = installGlobalErrorLogging()
  })

  afterEach(() => uninstall())

  it("logs an error event no boundary could have caught", () => {
    window.dispatchEvent(new ErrorEvent("error", { error: new RangeError("handler blew up"), message: "handler blew up" }))

    const logged = errorLogLines(api).find((line) => line.includes("window.error"))
    expect(logged).toBeDefined()
    expect(logged).toContain("RangeError: handler blew up")
  })

  it("logs an unhandled promise rejection", () => {
    // jsdom does not implement PromiseRejectionEvent, so the shape the listener reads is built
    // by hand: a plain "unhandledrejection" event carrying a reason.
    const event = Object.assign(new Event("unhandledrejection"), { reason: new Error("nobody awaited this") })
    window.dispatchEvent(event)

    const logged = errorLogLines(api).find((line) => line.includes("window.unhandledrejection"))
    expect(logged).toBeDefined()
    expect(logged).toContain("Error: nobody awaited this")
  })

  it("logs what is not an Error at all", () => {
    // A rejection reason is whatever was passed to reject(), and an "error" event raised
    // cross-origin carries a message with no error object. Neither has a name or a stack.
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "just a string" }))
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }))

    expect(errorLogLines(api)).toEqual([expect.stringContaining("NonError: just a string"), expect.stringContaining("NonError: Script error.")])
  })

  it("stops logging once the disposer runs", () => {
    uninstall()

    // Vitest's jsdom environment reports a dispatched "error" event as an unhandled error unless
    // the page holds an error listener of its own, and the disposer just removed the only one.
    const keepVitestQuiet = (): void => {}
    window.addEventListener("error", keepVitestQuiet)
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("after"), message: "after" }))
    window.removeEventListener("error", keepVitestQuiet)

    expect(errorLogLines(api)).toEqual([])
  })
})
