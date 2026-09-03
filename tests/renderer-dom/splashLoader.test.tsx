import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"

import { Loader } from "@renderer/App"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The splash used to come down on a flat `setTimeout(..., 2000)` and nothing else, so a launch
 * that was ready in half a second still sat behind it for two. What these pin is that the timer
 * is now a floor rather than the thing being waited for: the config arriving is what lifts it,
 * and a config that never arrives keeps it up however long the floor has been past.
 */
describe("the launch splash", () => {
  it("stays up while the config has not arrived, however long that takes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    installMockWindowApi({
      // Never resolves: the launch is still waiting, and the splash has nothing to hand over to.
      configManager: { getConfig: () => new Promise<ConfigType>(() => {}) }
    })

    renderWithProviders(<Loader />)

    expect(await screen.findByText("Welcome to RiftLauncher!")).toBeTruthy()

    // Far past the floor. Under the old fixed timer this alone took the splash down.
    await vi.advanceTimersByTimeAsync(5_000)

    expect(screen.queryByText("Welcome to RiftLauncher!")).toBeTruthy()

    vi.useRealTimers()
  })

  it("comes down once the config has arrived", async () => {
    installMockWindowApi()

    renderWithProviders(<Loader />)

    expect(await screen.findByText("Welcome to RiftLauncher!")).toBeTruthy()

    // The default mock resolves getConfig with a real config, so this is the ordinary launch:
    // the splash serves its floor and then goes, without anyone waiting two seconds for it.
    await waitFor(() => expect(screen.queryByText("Welcome to RiftLauncher!")).toBeNull())
  })

  it("still comes down, into a usable default config, when getConfig rejects", async () => {
    // Before ConfigContext's loading effect caught this, a rejected getConfig left
    // config.schemaVersion at its 0 sentinel forever, isConfigLoaded never flipped, and the
    // splash — which now waits on schemaVersion !== 0 rather than the old fixed timer — stayed
    // up for the rest of the session. Nothing here retries the read; it degrades once, to the
    // reducer's own default config, so a launch that cannot read its config file still reaches
    // a usable window instead of a launcher that never gets past its splash.
    const api = installMockWindowApi({
      configManager: { getConfig: () => Promise.reject(new Error("disk full")) }
    })

    renderWithProviders(<Loader />)

    expect(await screen.findByText("Welcome to RiftLauncher!")).toBeTruthy()

    await waitFor(() => expect(screen.queryByText("Welcome to RiftLauncher!")).toBeNull())

    expect(api.utils.logMessage).toHaveBeenCalledWith("error", expect.stringContaining("Error reading the config file"))
  })
})
