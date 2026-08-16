import { describe, expect, it, vi } from "vitest"
import { act, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CONFIG_ACTIONS, useConfigDispatch, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/** Reaches into ConfigContext from inside the provider to fire a real config change, the only way SAVE_CONFIG's effect (which lives inside ConfigProvider) can be triggered from a test. */
function BumpInstallationsFolder(): JSX.Element {
  const { defaultInstallationsFolder } = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  return <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER, payload: `${defaultInstallationsFolder}x` })}>bump</button>
}

describe("ConfigProvider save health", () => {
  it("stays quiet on a save that succeeds", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig()) } })

    renderWithProviders(
      <>
        <BumpInstallationsFolder />
        <NotificationsOverlay />
      </>
    )

    await user.click(await screen.findByRole("button", { name: "bump" }))

    // Give the fire-and-forget saveConfig().then(...) a turn to run.
    await act(async () => {})
    expect(api.configManager.saveConfig).toHaveBeenCalledTimes(1)
    expect(api.configManager.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ defaultInstallationsFolder: "x" }))
    expect(screen.queryByText(/couldn't be saved/i)).toBeNull()
  })

  it("notifies once a save failure streak crosses the threshold, and stays quiet on the first, isolated failure", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: false, reason: "write-failed" }) as SaveConfigResult)
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig()), saveConfig } })

    renderWithProviders(
      <>
        <BumpInstallationsFolder />
        <NotificationsOverlay />
      </>
    )

    const bump = await screen.findByRole("button", { name: "bump" })

    // First failure alone: CONFIG_SAVE_FAILURE_STREAK_THRESHOLD is 2, so this stays quiet (see saveHealth.ts).
    await user.click(bump)
    await act(async () => {})
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/couldn't be saved/i)).toBeNull()

    // Second consecutive failure crosses the threshold: the player is told, for real, via the overlay.
    await user.click(bump)
    const notice = await screen.findByText(/couldn't be saved to disk/i)
    expect(notice).toBeTruthy()
    expect(saveConfig).toHaveBeenCalledTimes(2)
  })
})
