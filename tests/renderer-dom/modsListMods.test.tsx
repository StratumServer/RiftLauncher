import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/** One `/api/mods` entry, just enough of the shape parseModListResponse and ListMods both read. */
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
 * Edits the currently selected installation's path in place, id and
 * lastUsedInstallation untouched, exactly what a "manage installation" flow
 * does while ListMods stays mounted in the background.
 */
function EditInstallationPathButton({ newPath }: { newPath: string }): JSX.Element {
  const configDispatch = useConfigDispatch()
  return <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: "install-a", updates: { path: newPath } } })}>edit installation path</button>
}

describe("ListMods", () => {
  it("renders results from the mocked ModDB query", async () => {
    installMockWindowApi({
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify(MOD_RESPONSE)
          // authors/gameversions/tags dropdowns query on mount too; an empty named list is enough for them.
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    const modCard = await screen.findByText("Better Ruins", {}, { timeout: 3000 })
    expect(modCard).toBeTruthy()
    expect(screen.getByText("Someone")).toBeTruthy()

    // The ModDB grid can grow into the hundreds on scroll, so its logo image must stay
    // off the initial paint until it nears the viewport.
    expect(screen.getByAltText("Better Ruins").getAttribute("loading")).toBe("lazy")
  })

  it("shows the no-matching-filters state when the ModDB query comes back empty", async () => {
    installMockWindowApi({
      netManager: {
        queryURL: async () => JSON.stringify({ statuscode: "200", mods: [], authors: [], gameversions: [], tags: [] })
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    expect(await screen.findByText("There are no Mods that match your filters!", {}, { timeout: 3000 })).toBeTruthy()
  })

  it("picks up an edit to the current installation without lastUsedInstallation changing", async () => {
    const user = userEvent.setup()

    // "installed" only for the Mods folder under /games/b, so the mod card's
    // installed styling can only flip once ListMods re-scans with the edited path.
    const getInstalledMods = vi.fn(async (path: string) =>
      path.startsWith("/games/b") ? { mods: [{ name: "Better Ruins", modid: "betterruins", version: "1.0.0", path }], errors: [] } : { mods: [], errors: [] }
    )

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: "install-a", installations: [anInstallation()] }))
      },
      modsManager: { getInstalledMods },
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
        <EditInstallationPathButton newPath="/games/b" />
      </TaskProvider>,
      { route: "/mods" }
    )

    await screen.findByText("Better Ruins", {}, { timeout: 3000 })

    // Scanned the original path on mount, and the card is not shown as installed yet.
    await waitFor(() => expect(getInstalledMods).toHaveBeenCalledWith(expect.stringContaining("/games/a")))
    const cardBefore = screen.getByText("Better Ruins").closest("li")?.firstElementChild as HTMLElement
    expect(cardBefore.className).not.toContain("bg-vsd/50")

    // Edits the installation currently shown, id and lastUsedInstallation both untouched.
    await user.click(screen.getByRole("button", { name: "edit installation path" }))

    // ListMods must derive the edited installation and re-scan its (new) Mods folder,
    // instead of keeping the snapshot it copied in before the edit.
    await waitFor(() => expect(getInstalledMods).toHaveBeenCalledWith(expect.stringContaining("/games/b")))
    await waitFor(() => {
      const cardAfter = screen.getByText("Better Ruins").closest("li")?.firstElementChild as HTMLElement
      expect(cardAfter.className).toContain("bg-vsd/50")
    })
  })
})
