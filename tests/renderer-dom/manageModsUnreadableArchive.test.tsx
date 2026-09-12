import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageMods from "@renderer/features/installations/pages/ManageMods"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const BROKEN_PATH = "/games/a/Mods/broken.zip"

function anInstallation(): InstallationType {
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
    envVars: ""
  }
}

/** Renders Manage Mods over a folder holding one archive the scan could not read, and returns its row. */
async function renderWithUnreadableArchive(deletePath: BridgeAPI["pathsManager"]["deletePath"]): Promise<HTMLElement> {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    netManager: { queryURL: vi.fn(async () => JSON.stringify({ statuscode: "404" })) },
    modsManager: { getInstalledMods: vi.fn(async () => ({ mods: [], errors: [{ zipname: "broken.zip", path: BROKEN_PATH }] })) },
    pathsManager: { deletePath }
  })

  renderWithProviders(
    <Routes>
      <Route
        path="/installations/mods/:id"
        element={
          <TaskProvider>
            <ManageMods />
            <NotificationsOverlay />
          </TaskProvider>
        }
      />
    </Routes>,
    { route: "/installations/mods/install-a" }
  )

  return (await screen.findByText("broken.zip", {}, { timeout: 3000 })).closest("li") as HTMLElement
}

/** An archive the scan could not read has no modinfo and no ModDB entry: deleting it is all the page offers. */
describe("ManageMods: an unreadable archive", () => {
  it("deletes it by its path, only once the confirmation is accepted", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const row = await renderWithUnreadableArchive(deletePath)

    await user.click(within(row).getByTitle("Delete"))

    const dialog = await screen.findByRole("dialog")
    expect(deletePath).not.toHaveBeenCalled()
    await user.click(within(dialog).getByTitle("Delete"))

    await waitFor(() => expect(deletePath).toHaveBeenCalledWith(BROKEN_PATH))
    expect(await screen.findByText("Mod deleted successfully.")).toBeTruthy()
  })

  it("deletes nothing when the confirmation is cancelled or dismissed with Escape", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const row = await renderWithUnreadableArchive(deletePath)

    await user.click(within(row).getByTitle("Delete"))
    await user.click(within(await screen.findByRole("dialog")).getByTitle("Cancel"))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await user.click(within(row).getByTitle("Delete"))
    await screen.findByRole("dialog")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    expect(deletePath).not.toHaveBeenCalled()
    expect(screen.queryByText("Mod deleted successfully.")).toBeNull()
    expect(screen.getByText("broken.zip")).toBeTruthy()
  })
})
