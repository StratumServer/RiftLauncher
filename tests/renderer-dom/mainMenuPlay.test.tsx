import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import MainMenu from "@renderer/components/layout/MainMenu"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The smoke test #460 owes the main menu.
 *
 * Lifting `PlayHandler` out of MainMenu and into `useLaunchGame` touched the only launch path in
 * the app, and nothing under tests/renderer-dom covered MainMenu before. This does not re-test the
 * hook (tests/ipc/gameHandlers.test.ts pins what actually reaches the game); it pins that Play
 * still reaches the bridge with the selected Installation, and with no server attached.
 */
describe("MainMenu", () => {
  const installation = {
    id: "i-1",
    name: "Main",
    icon: "",
    path: "/mock/installations/main",
    version: "1.22.7",
    gameVersionId: "gv-1",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: ""
  } satisfies InstallationType

  it("starts the selected Installation with no server when Play is pressed", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn<BridgeAPI["gameManager"]["executeGame"]>(async () => ({ ok: true, exitCode: 0 }) as GameExecutionResult)

    installMockWindowApi({
      configManager: {
        getConfig: async () =>
          createMockConfig({
            schemaVersion: 5,
            lastUsedInstallation: "i-1",
            installations: [installation],
            gameVersions: [{ id: "gv-1", version: "1.22.7", label: "1.22.7", path: "/mock/versions/1.22.7" }]
          })
      },
      gameManager: { executeGame }
    })

    renderWithProviders(
      <TaskProvider>
        <MainMenu />
      </TaskProvider>,
      { route: "/" }
    )

    await user.click(await screen.findByRole("button", { name: "Play" }))

    expect(executeGame).toHaveBeenCalledTimes(1)
    expect(executeGame.mock.calls[0]?.[1]?.id).toBe("i-1")
    expect(executeGame.mock.calls[0]?.[2]).toBe(undefined)
  })
})
