/**
 * The settings toggle that lets a session be kept on a machine with no system keyring (#481).
 *
 * Three things are worth holding still. It is off for a config nobody has answered, since the
 * store it opts into seals a session with a key that ships in the binary. The sentence under it
 * says so in the player's own words rather than leaving them to find out. And because Chromium
 * chooses its password store as the process starts, touching it changes nothing until the next
 * launch, which the toggle has to say out loud rather than look like it did nothing.
 */
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ConfigPage from "@renderer/features/config/pages/ConfigPage"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const TOGGLE_TITLE =
  "Keeps you logged in on a computer with no system keyring. The session is then written to disk sealed with a key built into the launcher, so any program running as you can read it. Leave this off unless that is fine on this computer. Takes effect the next time RiftLauncher starts."

function renderConfigPage(allowBasicSessionStore = false): MockedBridgeAPI {
  const api = installMockWindowApi({
    configManager: { getConfig: async () => createMockConfig({ allowBasicSessionStore }) },
    // The background section fetches its catalog on mount. An empty list keeps it out of the way.
    netManager: { queryURL: vi.fn(async () => "[]") }
  })

  renderWithProviders(
    <>
      <ConfigPage />
      <NotificationsOverlay />
    </>,
    { route: "/config" }
  )
  return api
}

/** The last config the page pushed at the main process. */
function lastSavedConfig(api: MockedBridgeAPI): ConfigType {
  const calls = vi.mocked(api.configManager.saveConfig).mock.calls
  return calls[calls.length - 1]?.[0] as ConfigType
}

describe("ConfigPage session storage toggle", () => {
  it("is off for a config nobody has answered", async () => {
    renderConfigPage()

    expect((await screen.findByTitle(TOGGLE_TITLE)).getAttribute("aria-checked")).toBe("false")
  }, 15000)

  it("says what the session is stored with, and who else could read it", async () => {
    renderConfigPage()

    expect(await screen.findByText(/sealed with a key built into the launcher, so any program running as you can read it/i)).toBeTruthy()
  }, 15000)

  it("stores the opt-in and says a restart is what acts on it", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage()

    await user.click(await screen.findByTitle(TOGGLE_TITLE))

    await waitFor(() => expect(lastSavedConfig(api).allowBasicSessionStore).toBe(true))
    // Inside the banner region, not the description, which carries the same sentence.
    expect(await within(screen.getByRole("status")).findByText(/takes effect the next time riftlauncher starts/i)).toBeTruthy()
  }, 15000)

  it("stores the opt-out again for someone who changes their mind", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage(true)

    const toggle = await screen.findByTitle(TOGGLE_TITLE)
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    await user.click(toggle)

    await waitFor(() => expect(lastSavedConfig(api).allowBasicSessionStore).toBe(false))
  }, 15000)
})
