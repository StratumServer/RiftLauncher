import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListInstallations from "@renderer/features/installations/pages/ListInstallations"
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
    ...overrides
  }
}

describe("ListInstallations", () => {
  it("leaves the Installation alone until the confirm dialog is accepted, then drops it", async () => {
    const user = userEvent.setup()
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) } })

    renderWithProviders(
      <TaskProvider>
        <ListInstallations />
      </TaskProvider>,
      { route: "/installations" }
    )

    await screen.findByText("Install A")

    await user.click(screen.getByTitle("Delete Installation"))

    // The confirm dialog is up. The Installation is still in the list behind it:
    // clicking the trash icon alone must not have deleted anything yet.
    await screen.findByText("Are you sure you want to delete this Installation?")
    expect(screen.getByText("Install A")).toBeTruthy()

    await user.click(screen.getByTitle("Delete"))

    // deleteData starts unchecked, so this goes through deleteInstallation's
    // ok-without-touching-disk path (see src/domain/installations/delete.ts):
    // the record still has to disappear from the list once that resolves.
    await waitFor(() => expect(screen.queryByText("Install A")).toBeNull())
    await waitFor(() => expect(screen.queryByText("Are you sure you want to delete this Installation?")).toBeNull())
  })

  it("does not delete when the confirm dialog is cancelled", async () => {
    const user = userEvent.setup()
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) } })

    renderWithProviders(
      <TaskProvider>
        <ListInstallations />
      </TaskProvider>,
      { route: "/installations" }
    )

    await screen.findByText("Install A")

    await user.click(screen.getByTitle("Delete Installation"))
    await screen.findByText("Are you sure you want to delete this Installation?")

    await user.click(screen.getByTitle("Cancel"))

    await waitFor(() => expect(screen.queryByText("Are you sure you want to delete this Installation?")).toBeNull())
    expect(screen.getByText("Install A")).toBeTruthy()
  })

  it("renders Manage Worlds beside Delete in the actions strip", async () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) } })

    renderWithProviders(
      <TaskProvider>
        <ListInstallations />
      </TaskProvider>,
      { route: "/installations" }
    )

    const deleteBtn = await screen.findByTitle("Delete Installation")
    const worldsBtn = await screen.findByTitle("Manage Worlds")
    expect(deleteBtn.parentElement).toBe(worldsBtn.parentElement)
  })

  describe("an Installation whose folder holds another managed folder (#713)", () => {
    async function deleteAWithData(config: Partial<ConfigType>): Promise<{ deletePath: ReturnType<typeof vi.fn> }> {
      const user = userEvent.setup()
      const deletePath = vi.fn(async () => true)
      installMockWindowApi({
        configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()], ...config })) },
        pathsManager: { deletePath }
      })

      renderWithProviders(
        <TaskProvider>
          <ListInstallations />
          <NotificationsOverlay />
        </TaskProvider>,
        { route: "/installations" }
      )

      await screen.findByText("Install A")
      await user.click(screen.getAllByTitle("Delete Installation")[0]!)
      await user.click(await screen.findByLabelText("Delete data"))
      await user.click(screen.getByTitle("Delete"))
      return { deletePath }
    }

    it.each([
      ["another Installation", { installations: [anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/a/b" })] }, "/games/a/b"],
      ["a VS Version", { gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/games/a/game" }] }, "/games/a/game"],
      ["the Backups folder", { backupsFolder: "/games/a/Backups" }, "/games/a/Backups"],
      ["another Installation on the same folder", { installations: [anInstallation(), anInstallation({ id: "install-b", name: "Install B" })] }, "/games/a"]
    ])("says which folder to move when it holds %s, and removes nothing", async (_name, config, held) => {
      const { deletePath } = await deleteAWithData(config as Partial<ConfigType>)

      expect(await screen.findByText(new RegExp(`holds ${held.replaceAll("/", "\\/")}, which the launcher also manages`))).toBeTruthy()
      expect(deletePath).not.toHaveBeenCalled()
      expect(screen.getByText("Install A")).toBeTruthy()
    })

    it("deletes without the data even when it holds another Installation", async () => {
      const user = userEvent.setup()
      installMockWindowApi({
        configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/a/b" })] })) }
      })

      renderWithProviders(
        <TaskProvider>
          <ListInstallations />
        </TaskProvider>,
        { route: "/installations" }
      )

      await screen.findByText("Install A")
      await user.click(screen.getAllByTitle("Delete Installation")[0]!)
      await user.click(await screen.findByTitle("Delete"))

      await waitFor(() => expect(screen.queryByText("Install A")).toBeNull())
      expect(screen.getByText("Install B")).toBeTruthy()
    })
  })
})
