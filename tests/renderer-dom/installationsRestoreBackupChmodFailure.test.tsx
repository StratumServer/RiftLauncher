import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Routes, Route } from "react-router-dom"

import ManageInstallationBackups from "@renderer/features/installations/pages/ManageInstallationBackups"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Pins issue #10: TaskManagerContext's startExtract used to fire changePerms
 * without awaiting or catching it, so a rejected chmod became an unhandled
 * rejection instead of failing the task. It is now awaited inside the
 * existing try/catch, so a rejection surfaces exactly like any other
 * extraction failure: the restore is refused with "extract-failed" and the
 * generic restore-error notification shows.
 */

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
    <>
      <Routes>
        <Route
          path="/installations/backups/:id"
          element={
            <TaskProvider>
              <ManageInstallationBackups />
            </TaskProvider>
          }
        />
      </Routes>
      <NotificationsOverlay />
    </>,
    { route: `/installations/backups/${installationId}` }
  )
}

describe("ManageInstallationBackups restore, chmod failure", () => {
  it("fails the restore when changePerms rejects after a successful extraction", async () => {
    const user = userEvent.setup()
    const extractOnPath = vi.fn(async () => true)
    const changePerms = vi.fn(async () => {
      throw new Error("chmod: Operation not permitted")
    })
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        checkPathExists: vi.fn(async () => true),
        movePath: vi.fn(async () => true),
        deletePath: vi.fn(async () => true),
        extractOnPath,
        changePerms
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")

    await user.click(screen.getByTitle("Restore"))

    await waitFor(() => expect(changePerms).toHaveBeenCalledTimes(1))

    // A rejected chmod is treated as a failed extraction, so the restore
    // is refused and the same error notification a real extract failure
    // would raise shows up: the chmod rejection did not vanish as an
    // unhandled rejection nobody caught.
    await screen.findByText("The Backup could not be restored, so your Installation was left as it was.")
  })
})
