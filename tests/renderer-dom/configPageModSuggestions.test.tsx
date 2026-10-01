/**
 * The "Mod suggestions" switch on the settings page (#546): the third way, besides the opt-in
 * card's own buttons and the row's "Turn off suggestions", to answer whether the Mods browse page
 * fetches and shows compatible Mod suggestions.
 */
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ConfigPage from "@renderer/features/config/pages/ConfigPage"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const TOGGLE_TITLE = "Show compatible Mod suggestions on the Mods browse page. Off hides the row and the opt-in card alike."

function renderConfigPage(modSuggestionsConsent: boolean | null = null): MockedBridgeAPI {
  const api = installMockWindowApi({
    configManager: { getConfig: async () => createMockConfig({ modSuggestionsConsent }) },
    // The background section fetches its catalog on mount. An empty list keeps it out of the way.
    netManager: { queryURL: vi.fn(async () => "[]") }
  })

  renderWithProviders(<ConfigPage />, { route: "/config" })
  return api
}

/** The last config the page pushed at the main process. */
function lastSavedConfig(api: MockedBridgeAPI): ConfigType {
  const calls = vi.mocked(api.configManager.saveConfig).mock.calls
  return calls[calls.length - 1]?.[0] as ConfigType
}

async function suggestionsToggle(): Promise<HTMLElement> {
  return await screen.findByTitle(TOGGLE_TITLE)
}

describe("ConfigPage Mod suggestions toggle", () => {
  it("reads off for a config nobody has answered, same as a config that declined", async () => {
    renderConfigPage(null)
    expect((await suggestionsToggle()).getAttribute("aria-checked")).toBe("false")
  })

  it("reads on for a config that already opted in", async () => {
    renderConfigPage(true)
    expect((await suggestionsToggle()).getAttribute("aria-checked")).toBe("true")
  })

  it("turns the row on from an unanswered config", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage(null)

    await user.click(await suggestionsToggle())

    await waitFor(() => expect(lastSavedConfig(api).modSuggestionsConsent).toBe(true))
    expect((await suggestionsToggle()).getAttribute("aria-checked")).toBe("true")
  })

  it("turns the row back off once it was on", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage(true)

    await waitFor(async () => expect((await suggestionsToggle()).getAttribute("aria-checked")).toBe("true"))
    await user.click(await suggestionsToggle())

    await waitFor(() => expect(lastSavedConfig(api).modSuggestionsConsent).toBe(false))
    expect((await suggestionsToggle()).getAttribute("aria-checked")).toBe("false")
  })
})
