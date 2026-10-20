import { describe, expect, it, vi } from "vitest"
import { act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import InstallMod from "@renderer/features/mods/pages/InstallMod"
import { claimModWrites, modWriteKey, releaseModWrites } from "@renderer/features/mods/hooks/modWrites"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.20.0",
    gameVersionId: "gv-1",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    _modsCount: 0,
    ...overrides
  }
}

/**
 * Picking a release used to happen in a dialog that covered the window, menus included, so the only
 * way out was dismissing it. It is a page now: it keeps the launcher's navigation reachable and is
 * left the same way every other page is. These hold the two halves a player depends on — the way
 * back, and a heading that names the mod straight away rather than echoing its numeric id.
 */
function aModDetail(): string {
  return JSON.stringify({
    statuscode: "200",
    mod: {
      modid: 42,
      assetid: 4242,
      name: "Cool Mod",
      releases: [
        {
          releaseid: 1,
          mainfile: "https://mods.example/coolmod-1.2.0.zip",
          filename: "coolmod-1.2.0.zip",
          fileid: 1,
          downloads: 0,
          tags: ["1.20.0"],
          modidstr: "coolmod",
          modversion: "1.2.0",
          created: "2026-01-02T00:00:00Z",
          changelog: ""
        }
      ]
    }
  })
}

function renderPage(queryURL: () => Promise<string>): void {
  installMockWindowApi({ netManager: { queryURL: vi.fn(queryURL) } })

  renderWithProviders(
    <TaskProvider>
      <Routes>
        <Route path="/mods/install/:modid" element={<InstallMod />} />
      </Routes>
    </TaskProvider>,
    { route: "/mods/install/42" }
  )
}

describe("the install-mod page", () => {
  it("offers a way back to the mod list", async () => {
    renderPage(async () => aModDetail())

    const back = await screen.findByRole("link", { name: "Go back" })
    expect(back.getAttribute("href")).toBe("/mods")

    // The breadcrumb is the second route out, and it names where the player came from.
    const crumb = await screen.findByRole("link", { name: "Mods" })
    expect(crumb.getAttribute("href")).toBe("/mods")
  })

  it("names the mod from the route it was opened with, before the ModDB answers", async () => {
    // A request that never settles: whatever the heading shows here it did not learn from ModDB.
    renderPage(() => new Promise<string>(() => {}))

    expect(await screen.findByText(/List of versions of the 42 Mod/i)).toBeTruthy()
  })

  it("replaces that with the real name once the catalog lands", async () => {
    renderPage(async () => aModDetail())

    await waitFor(() => expect(screen.getByText(/List of versions of the Cool Mod Mod/i)).toBeTruthy())
    expect(screen.getByText("1.2.0")).toBeTruthy()
  })

  it("disables release buttons while a write for the Mod is in flight and re-reads installed Mods when the write finishes (#735)", async () => {
    let installedVersion = "1.0.0"
    const getInstalledMods = vi.fn(async () => ({
      mods: [{ modid: "coolmod", name: "Cool Mod", version: installedVersion, path: `/mock/Installations/install-a/Mods/coolmod-${installedVersion}.zip`, enabled: true }],
      errors: []
    }))
    const twoReleasesDetail = JSON.stringify({
      statuscode: "200",
      mod: {
        modid: 42,
        assetid: 4242,
        name: "Cool Mod",
        releases: [
          {
            releaseid: 2,
            mainfile: "https://mods.example/coolmod-1.2.0.zip",
            filename: "coolmod-1.2.0.zip",
            fileid: 2,
            downloads: 0,
            tags: ["1.20.0"],
            modidstr: "coolmod",
            modversion: "1.2.0",
            created: "2026-01-03T00:00:00Z",
            changelog: ""
          },
          {
            releaseid: 1,
            mainfile: "https://mods.example/coolmod-1.1.0.zip",
            filename: "coolmod-1.1.0.zip",
            fileid: 1,
            downloads: 0,
            tags: ["1.20.0"],
            modidstr: "coolmod",
            modversion: "1.1.0",
            created: "2026-01-02T00:00:00Z",
            changelog: ""
          }
        ]
      }
    })
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: "install-a", installations: [anInstallation({ id: "install-a", version: "1.20.0" })] }))
      },
      modsManager: { getInstalledMods },
      netManager: { queryURL: vi.fn(async () => twoReleasesDetail) }
    })

    const key = modWriteKey("install-a", "coolmod")
    claimModWrites([key])
    try {
      renderWithProviders(
        <TaskProvider>
          <Routes>
            <Route path="/mods/install/:modid" element={<InstallMod />} />
          </Routes>
        </TaskProvider>,
        { route: "/mods/install/42" }
      )

      const releaseButtons = await screen.findAllByRole("button", { name: "Author tagged it as compatible with your selected Vintage Story Version." })
      expect(releaseButtons).toHaveLength(2)
      expect((releaseButtons[0] as HTMLButtonElement).disabled).toBe(true)
      expect((releaseButtons[1] as HTMLButtonElement).disabled).toBe(true)

      installedVersion = "1.2.0"
      act(() => {
        releaseModWrites([key])
      })

      await waitFor(() => expect(getInstalledMods.mock.calls.length).toBeGreaterThanOrEqual(2))
      await waitFor(() => {
        const updatedButtons = screen.getAllByRole("button", { name: "Author tagged it as compatible with your selected Vintage Story Version." })
        expect((updatedButtons[0] as HTMLButtonElement).disabled).toBe(true)
        expect((updatedButtons[1] as HTMLButtonElement).disabled).toBe(false)
      })
    } finally {
      releaseModWrites([key])
    }
  })

  it("refuses a release click while the installation is busy with a backup or restore", async () => {
    const user = userEvent.setup()
    const downloadOnPath = vi.fn()
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            lastUsedInstallation: "install-a",
            installations: [anInstallation({ id: "install-a", version: "1.20.0", _backuping: true })]
          })
        )
      },
      pathsManager: { downloadOnPath },
      netManager: { queryURL: vi.fn(async () => aModDetail()) }
    })

    renderWithProviders(
      <TaskProvider>
        <NotificationsOverlay />
        <Routes>
          <Route path="/mods/install/:modid" element={<InstallMod />} />
        </Routes>
      </TaskProvider>,
      { route: "/mods/install/42" }
    )

    const releaseButton = await screen.findByTitle("Author tagged it as compatible with your selected Vintage Story Version.")
    await user.click(releaseButton)

    await screen.findByText("You can't update a Mod while it's in use.")
    expect(downloadOnPath).not.toHaveBeenCalled()
  })
})
