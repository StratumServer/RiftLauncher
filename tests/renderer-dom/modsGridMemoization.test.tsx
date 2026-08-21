import { describe, expect, it, vi } from "vitest"
import { memo, createElement } from "react"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Replaces the real ModListCard with a spy so this suite can count how many times a
 * given card's render body actually runs. Scoped to this file only (vi.mock is
 * per-module-per-test-file), so other suites still exercise the real component.
 */
const { cardRenderSpy } = vi.hoisted(() => ({
  cardRenderSpy: vi.fn((props: { mod: { modid: number; name: string } }) => createElement("div", { "data-testid": `mod-card-${props.mod.modid}` }, props.mod.name))
}))
vi.mock("@renderer/features/mods/components/ModListCard", () => ({
  default: memo(cardRenderSpy)
}))

const MOD_RESPONSE = {
  statuscode: "200",
  mods: [
    {
      modid: 123,
      assetid: 123,
      name: "Better Ruins",
      summary: "More interesting ruins.",
      modidstrs: ["betterruins"],
      author: "Someone",
      downloads: 42,
      follows: 7,
      comments: 1,
      side: "both",
      logo: "",
      tags: []
    }
  ]
}

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

/**
 * Edits a field ModsGrid's props never depend on (start params), so the only thing this
 * proves is whether an unrelated ListMods re-render leaks into a card that memo should
 * have skipped. id and path stay untouched, so the installed-mods rescan effect
 * (keyed on installation?.id/path) never refires either.
 */
function EditInstallationStartParamsButton(): JSX.Element {
  const configDispatch = useConfigDispatch()
  return <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: "install-a", updates: { startParams: "--unrelated-flag" } } })}>edit start params</button>
}

describe("ModsGrid card memoization", () => {
  it("does not re-render a mod card when ListMods re-renders for an unrelated reason", async () => {
    const user = userEvent.setup()

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: "install-a", installations: [anInstallation()] }))
      },
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify(MOD_RESPONSE)
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
        <EditInstallationStartParamsButton />
      </TaskProvider>,
      { route: "/mods" }
    )

    await screen.findByTestId("mod-card-123", {}, { timeout: 3000 })
    expect(cardRenderSpy).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole("button", { name: "edit start params" }))

    // No observable effect of the edit reaches ModsGrid, so there is nothing to await on
    // the mods side; give React a tick to flush the re-render this dispatch does cause.
    await waitFor(() => expect(cardRenderSpy.mock.calls.length).toBeGreaterThanOrEqual(1))

    expect(cardRenderSpy).toHaveBeenCalledTimes(1)
  })
})
