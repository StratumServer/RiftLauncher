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
})
