import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Routes, Route } from "react-router-dom"

import ManageInstallationBackups from "@renderer/features/installations/pages/ManageInstallationBackups"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallationWithBackup(): InstallationType {
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
    backups: [{ id: "backup-1", date: Date.now(), path: "/backups/a/backup-1.zip" }],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    _modsCount: 0
  }
}

/** ManageInstallationBackups reads its Installation id off the route, so the harness needs a real Route match, not just a MemoryRouter entry. */
function renderManageBackups(installationId: string): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <Routes>
      <Route
        path="/installations/backups/:id"
        element={
          <TaskProvider>
            <ManageInstallationBackups />
          </TaskProvider>
        }
      />
    </Routes>,
    { route: `/installations/backups/${installationId}` }
  )
}

describe("ManageInstallationBackups", () => {
  it("does not touch the backup until the restore confirm dialog is accepted", async () => {
    const user = userEvent.setup()
    const extractOnPath = vi.fn(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        checkPathExists: vi.fn(async () => true),
        movePath: vi.fn(async () => true),
        deletePath: vi.fn(async () => true),
        extractOnPath,
        changePerms: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")

    expect(extractOnPath).not.toHaveBeenCalled()
  })

  it("extracts the backup archive over the Installation once the restore is confirmed", async () => {
    const user = userEvent.setup()
    const extractOnPath = vi.fn<BridgeAPI["pathsManager"]["extractOnPath"]>(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        checkPathExists: vi.fn(async () => true),
        movePath: vi.fn(async () => true),
        deletePath: vi.fn(async () => true),
        extractOnPath,
        changePerms: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")

    await user.click(screen.getByTitle("Restore"))

    await waitFor(() => expect(extractOnPath).toHaveBeenCalledTimes(1))
    expect(extractOnPath.mock.calls[0]?.[1]).toBe("/backups/a/backup-1.zip")

    // The confirm dialog closes as part of the same click.
    await waitFor(() => expect(screen.queryByText("Are you sure you want to restore this Backup?")).toBeNull())
  })

  it("deletes the backup archive after the delete confirmation", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        deletePath,
        extractOnPath: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Delete"))
    await screen.findByText("Are you sure you want to delete this Backup?")
    await user.click(screen.getAllByTitle("Delete")[1]!)

    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))
    expect(deletePath.mock.calls[0]?.[0]).toBe("/backups/a/backup-1.zip")
    await waitFor(() => expect(screen.queryByTitle("Delete")).toBeNull())
  })

  it("does not start a second deletion while the first one is in flight", async () => {
    const user = userEvent.setup()
    let resolveDelete: (result: boolean) => void = () => {}
    const deletePath = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDelete = resolve
        })
    )
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        deletePath,
        extractOnPath: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Delete"))
    await screen.findByText("Are you sure you want to delete this Backup?")
    await user.click(screen.getAllByTitle("Delete")[1]!)

    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTitle("Delete")).toBeNull())

    resolveDelete(true)
    await waitFor(() => expect(screen.queryByText("Are you sure you want to delete this Backup?")).toBeNull())
  })

  it("clears the deleting state when the archive deletion fails", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        deletePath,
        extractOnPath: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Delete"))
    await screen.findByText("Are you sure you want to delete this Backup?")
    await user.click(screen.getAllByTitle("Delete")[1]!)
    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTitle("Delete")).toBeTruthy())

    await user.click(screen.getByTitle("Delete"))
    await screen.findByText("Are you sure you want to delete this Backup?")
    await user.click(screen.getAllByTitle("Delete")[1]!)
    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(2))
  })
})
