import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import App from "@renderer/App"
import { installGlobalErrorLogging } from "@renderer/adapters/errorLog"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * A value a maintainer must never find in error.log. Nothing marks it: no `password=` prefix, no
 * query key, no absolute path, so the main-process redactor has no reason to touch it.
 */
const SECRET = "sk-live-9f3a2b1c8d7e6f5a"

// The page ManageMods route renders, replaced by one that throws the way beta.7's did: a
// TypeError raised on the very first render, before anything is on screen (#370).
vi.mock("@renderer/features/installations/pages/ManageMods", () => ({
  default: function ExplodingManageMods(): JSX.Element {
    throw new TypeError("Cannot read properties of null (reading 'toLowerCase')")
  }
}))

/**
 * Home is the route the fallback's first action leads to, and it is inside the boundary itself,
 * so it is the case the recovery has to survive. This wraps the real page in a switch a test can
 * flip, which is how "the page stopped throwing" is expressed here.
 */
const home = vi.hoisted(() => ({ throws: false, message: "Cannot read properties of null (reading 'installations')" }))

vi.mock("@renderer/features/home/pages/HomePage", async (importOriginal) => {
  const actual = await importOriginal<{ default: () => JSX.Element }>()

  return {
    default: function GuardedHomePage(): JSX.Element {
      if (home.throws) throw new TypeError(home.message)
      return actual.default()
    }
  }
})

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

function findFallback(): Promise<HTMLElement> {
  return screen.findByRole("alert", { name: "This page couldn't be displayed" })
}

describe("a page that throws", () => {
  silenceReactErrorLogging()

  beforeEach(() => {
    window.location.hash = "#/installations/mods/1"
  })

  it("shows the fallback in the page area while the shell stays mounted", async () => {
    renderApp()

    expect(await findFallback()).toBeTruthy()
    // The main menu, the session button and the activity center all live outside <main>.
    expect(screen.getByText("Manage your Installations")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy()
  })

  it("tells the player the launcher still works and where the log is", async () => {
    renderApp()

    const alert = await findFallback()

    expect(alert.textContent).toContain("The rest of the launcher still works")
    expect(alert.textContent).toContain("Debug info")
  })

  it("writes the error name, message and component stack to the log", async () => {
    const api = renderApp()

    await findFallback()

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

    await findFallback()

    const goHome = screen.getByRole("button", { name: "Go to the main menu" })
    expect(document.activeElement).toBe(goHome)

    await user.click(goHome)

    // The real home page, rendered where the fallback was.
    expect(await screen.findByRole("heading", { name: "Welcome to RiftLauncher" })).toBeTruthy()
    expect(screen.queryByRole("alert", { name: "This page couldn't be displayed" })).toBeNull()
  })
})

describe("a home page that throws", () => {
  silenceReactErrorLogging()

  beforeEach(() => {
    window.location.hash = "#/"
    home.throws = true
    home.message = "Cannot read properties of null (reading 'installations')"
  })

  afterEach(() => {
    home.throws = false
  })

  it("recovers once the page stops throwing, on the route the boundary is already on", async () => {
    const user = userEvent.setup()
    renderApp()

    await findFallback()

    // The first attempt cannot work: nothing has changed, so Home throws again. What matters is
    // that the boundary was cleared and Home was given a real attempt rather than being skipped.
    await user.click(screen.getByRole("button", { name: "Go to the main menu" }))
    expect(await findFallback()).toBeTruthy()

    home.throws = false
    await user.click(screen.getByRole("button", { name: "Go to the main menu" }))

    expect(await screen.findByRole("heading", { name: "Welcome to RiftLauncher" })).toBeTruthy()
    expect(screen.queryByRole("alert", { name: "This page couldn't be displayed" })).toBeNull()
  })

  it("still leads somewhere usable when the page keeps throwing", async () => {
    const user = userEvent.setup()
    renderApp()

    await findFallback()

    await user.click(screen.getByRole("button", { name: "Open Info & Help" }))

    expect(await screen.findByRole("heading", { name: "RiftLauncher Info & Help" })).toBeTruthy()
    expect(screen.queryByRole("alert", { name: "This page couldn't be displayed" })).toBeNull()
  })

  it("does not put the message it threw with on the bridge", async () => {
    home.message = SECRET
    const api = renderApp()

    await findFallback()

    const logged = errorLogLines(api).find((line) => line.includes("PageErrorBoundary"))
    expect(logged).toBeDefined()
    expect(logged).not.toContain(SECRET)
    expect(logged).toContain("TypeError: unclassified-message")
    // The component that threw is still named, which is what the log is for.
    expect(logged).toContain("GuardedHomePage")
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
    expect(logged).toContain("RangeError: unclassified-message")
  })

  it("logs an unhandled promise rejection", () => {
    // jsdom does not implement PromiseRejectionEvent, so the shape the listener reads is built
    // by hand: a plain "unhandledrejection" event carrying a reason.
    const event = Object.assign(new Event("unhandledrejection"), { reason: new Error("nobody awaited this") })
    window.dispatchEvent(event)

    const logged = errorLogLines(api).find((line) => line.includes("window.unhandledrejection"))
    expect(logged).toBeDefined()
    expect(logged).toContain("Error: unclassified-message")
  })

  it("logs what is not an Error at all, without the value it carried", () => {
    // A rejection reason is whatever was passed to reject(), and an "error" event raised
    // cross-origin carries a message with no error object. Neither has a name or a stack, and
    // neither is anything the renderer may repeat: reject(sessionKey) is a rejection reason too.
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: SECRET }))
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }))

    const lines = errorLogLines(api)
    expect(lines).toEqual([expect.stringContaining("window.unhandledrejection] Error: non-error-throw (string)"), expect.stringContaining("window.error] Error: non-error-throw (string)")])
    expect(lines.join("\n")).not.toContain(SECRET)
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
