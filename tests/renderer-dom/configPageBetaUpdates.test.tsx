/**
 * The beta versions toggle on the settings page.
 *
 * Two things are worth holding still here. The toggle shows what is actually in force, which on a
 * beta build with nothing stored is "on" even though the stored value is null, and touching it
 * writes a real answer through the config reducer, which is what the main process reads before it
 * asks the update server anything.
 */
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ConfigPage from "@renderer/features/config/pages/ConfigPage"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const BETA_TOGGLE_TITLE =
  "Toggle on to be offered beta versions of the launcher when it checks for updates. Turning it off while you are on a beta stops the next ones being offered and keeps the one you have until a stable release arrives."

function renderConfigPage({ version, receiveBetaUpdates }: { version: string; receiveBetaUpdates?: boolean | null }): MockedBridgeAPI {
  const api = installMockWindowApi({
    configManager: { getConfig: async () => createMockConfig({ receiveBetaUpdates: receiveBetaUpdates ?? null }) },
    utils: { getAppVersion: vi.fn(async () => version) },
    // The background section fetches its catalog on mount. An empty list keeps it out of the way.
    netManager: { queryURL: vi.fn(async () => "[]") }
  })

  renderWithProviders(<ConfigPage />, { route: "/config" })
  return api
}

/** The toggle, found through the description it carries as its tooltip, the way the backups one is. */
async function betaToggle(): Promise<HTMLElement> {
  return await screen.findByTitle(BETA_TOGGLE_TITLE)
}

/** The last config the page pushed at the main process. */
function lastSavedConfig(api: MockedBridgeAPI): ConfigType {
  const calls = vi.mocked(api.configManager.saveConfig).mock.calls
  return calls[calls.length - 1]?.[0] as ConfigType
}

describe("ConfigPage beta versions toggle", () => {
  it("is off on a stable build nobody has answered for", async () => {
    renderConfigPage({ version: "1.7.0" })

    await waitFor(async () => expect((await betaToggle()).getAttribute("aria-checked")).toBe("false"))
  })

  it("is on for a build already running a beta, which nobody had to ask for", async () => {
    renderConfigPage({ version: "1.7.0-beta.3" })

    await waitFor(async () => expect((await betaToggle()).getAttribute("aria-checked")).toBe("true"))
  })

  it("stores the opt-in when a stable build asks for betas", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage({ version: "1.7.0" })

    await user.click(await betaToggle())

    await waitFor(() => expect(lastSavedConfig(api).receiveBetaUpdates).toBe(true))
    expect((await betaToggle()).getAttribute("aria-checked")).toBe("true")
  })

  it("stores the opt-out when a beta build asks to stop being offered them", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage({ version: "1.7.0-beta.3" })

    await waitFor(async () => expect((await betaToggle()).getAttribute("aria-checked")).toBe("true"))
    await user.click(await betaToggle())

    await waitFor(() => expect(lastSavedConfig(api).receiveBetaUpdates).toBe(false))
    expect((await betaToggle()).getAttribute("aria-checked")).toBe("false")
  })

  it("stays off on a beta build that already opted out, whatever the version says", async () => {
    const api = renderConfigPage({ version: "1.7.0-beta.3", receiveBetaUpdates: false })

    // Waiting on the version read first, so this is the answer winning rather than the state
    // before it resolved, which also reads as off.
    await waitFor(() => expect(api.utils.getAppVersion).toHaveBeenCalled())
    expect((await betaToggle()).getAttribute("aria-checked")).toBe("false")
  })
})
