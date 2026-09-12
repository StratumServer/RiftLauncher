import { beforeEach, describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ConfigPage from "@renderer/features/config/pages/ConfigPage"
import { ACCENT_PRESETS, DEFAULT_ACCENT_ID } from "@domain/accentColors"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const TEAL = ACCENT_PRESETS.find((preset) => preset.id === "teal")!
const AMBER = ACCENT_PRESETS.find((preset) => preset.id === DEFAULT_ACCENT_ID)!

function renderConfigPage(accentColor: string = DEFAULT_ACCENT_ID): MockedBridgeAPI {
  const api = installMockWindowApi({ configManager: { getConfig: async () => createMockConfig({ accentColor }) } })
  renderWithProviders(<ConfigPage />, { route: "/config" })
  return api
}

/** The accentColor in the last config written to disk, which is what the next launch would read. */
function lastSavedAccentColor(api: MockedBridgeAPI): string | undefined {
  return vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0].accentColor
}

// The applied accent lives on the root element, which jsdom keeps for the whole file.
beforeEach(() => {
  document.documentElement.style.removeProperty("--color-vsl")
})

describe("ConfigPage accent color picker", () => {
  it("paints no override at startup for the shipped default, so the stylesheet's own token shows", async () => {
    renderConfigPage(DEFAULT_ACCENT_ID)
    await screen.findByRole("group", { name: "Accent color" })
    expect(document.documentElement.style.getPropertyValue("--color-vsl")).toBe("")
  })

  it("paints the stored preset at startup when it is not the default", async () => {
    renderConfigPage("teal")
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--color-vsl")).toBe(TEAL.hex))
  })

  it("marks exactly the stored preset pressed, and every other preset unpressed", async () => {
    renderConfigPage("teal")
    expect((await screen.findByRole("button", { name: TEAL.name })).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByRole("button", { name: AMBER.name }).getAttribute("aria-pressed")).toBe("false")
  })

  it("clicking a swatch selects it, repaints the root, and saves the new choice", async () => {
    const api = renderConfigPage(DEFAULT_ACCENT_ID)
    const user = userEvent.setup()

    const amberSwatch = await screen.findByRole("button", { name: AMBER.name })
    const tealSwatch = screen.getByRole("button", { name: TEAL.name })
    expect(amberSwatch.getAttribute("aria-pressed")).toBe("true")
    expect(tealSwatch.getAttribute("aria-pressed")).toBe("false")

    await user.click(tealSwatch)

    expect(tealSwatch.getAttribute("aria-pressed")).toBe("true")
    expect(amberSwatch.getAttribute("aria-pressed")).toBe("false")
    expect(document.documentElement.style.getPropertyValue("--color-vsl")).toBe(TEAL.hex)
    await waitFor(() => expect(lastSavedAccentColor(api)).toBe("teal"))
  })

  it("is reachable and operable from the keyboard, same as any other action", async () => {
    renderConfigPage(DEFAULT_ACCENT_ID)
    const user = userEvent.setup()

    const tealSwatch = await screen.findByRole("button", { name: TEAL.name })
    tealSwatch.focus()
    expect(document.activeElement).toBe(tealSwatch)

    await user.keyboard("{Enter}")
    expect(tealSwatch.getAttribute("aria-pressed")).toBe("true")
  })
})
