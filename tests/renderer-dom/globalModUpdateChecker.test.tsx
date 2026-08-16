import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import GlobalModUpdateChecker from "@renderer/components/layout/GlobalModUpdateChecker"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Stands in for useGetCompleteInstalledMods, which otherwise pulls in the
 * whole ModDB compatibility pipeline (network query, semver comparisons).
 * That pipeline has its own coverage; this file is only about issue #46's
 * de-dupe, so the mock just reports a fixed number of updates for whichever
 * installation it is asked about.
 */
const getCompleteInstalledMods = vi.hoisted(() => vi.fn())

vi.mock("@renderer/features/mods/hooks/useGetCompleteInstalledMods", (): { useGetCompleteInstalledMods: () => typeof getCompleteInstalledMods } => ({
  useGetCompleteInstalledMods: () => getCompleteInstalledMods
}))

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.20.0",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    ...overrides
  }
}

/** Reaches into ConfigContext to move `lastUsedInstallation` the same way the app does when the player switches installations. */
function SwitchInstallation(): JSX.Element {
  const configDispatch = useConfigDispatch()
  return (
    <>
      <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION, payload: null })}>leave installation</button>
      <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION, payload: "install-a" })}>revisit installation</button>
    </>
  )
}

describe("GlobalModUpdateChecker", () => {
  beforeEach(() => {
    getCompleteInstalledMods.mockReset()
    getCompleteInstalledMods.mockImplementation(({ onFinish }: { onFinish?: (updates: number) => void }) => {
      onFinish?.(2)
      return Promise.resolve({ mods: [], errors: [] })
    })
  })

  it("notifies once per installation and does not renotify on a revisit", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: "install-a", installations: [anInstallation()] }))
      }
    })

    renderWithProviders(
      <>
        <GlobalModUpdateChecker />
        <NotificationsOverlay />
        <SwitchInstallation />
      </>
    )

    // The config loads async, the checker's effect then fires and (after its
    // 2s delay) posts the toast.
    await screen.findByText(/Mods with available updates/i, {}, { timeout: 4_000 })
    expect(getCompleteInstalledMods).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText(/Mods with available updates/i)).toHaveLength(1)

    // Revisit: leave the installation, then come back to it. The checker
    // runs its check again (it always does), but the de-dupe list already
    // has this installation, so no second toast should appear.
    await user.click(screen.getByRole("button", { name: "leave installation" }))
    await user.click(screen.getByRole("button", { name: "revisit installation" }))

    await act(async () => {})
    expect(getCompleteInstalledMods).toHaveBeenCalledTimes(2)

    // Give the (would-be) second toast's 2s delay time to land, if it were
    // going to, then confirm it did not.
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    expect(screen.getAllByText(/Mods with available updates/i)).toHaveLength(1)
  }, 10_000)
})
