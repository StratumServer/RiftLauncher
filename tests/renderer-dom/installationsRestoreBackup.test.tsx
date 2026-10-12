import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Routes, Route } from "react-router-dom"

import ManageInstallationBackups from "@renderer/features/installations/pages/ManageInstallationBackups"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
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
    gameVersionId: "gv-1",
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
            <NotificationsOverlay />
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

  it("reserves the Installation in the main process for the restore and gives it back afterwards", async () => {
    const user = userEvent.setup()
    const acquireLease = vi.fn<BridgeAPI["installationActivity"]["acquireLease"]>(async () => ({ ok: true }))
    const releaseLease = vi.fn<BridgeAPI["installationActivity"]["releaseLease"]>(async () => undefined)
    const extractOnPath = vi.fn<BridgeAPI["pathsManager"]["extractOnPath"]>(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      installationActivity: { acquireLease, releaseLease },
      pathsManager: { checkPathExists: vi.fn(async () => true), movePath: vi.fn(async () => true), deletePath: vi.fn(async () => true), extractOnPath, changePerms: vi.fn(async () => true) }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")
    await user.click(screen.getByTitle("Restore"))

    await waitFor(() => expect(releaseLease).toHaveBeenCalledTimes(1))
    expect(acquireLease).toHaveBeenCalledTimes(1)
    expect(acquireLease.mock.calls[0]?.[0]).toBe("install-a")
    expect(releaseLease.mock.calls[0]?.[0]).toBe(acquireLease.mock.calls[0]?.[1])
    expect(extractOnPath).toHaveBeenCalledTimes(1)
  })

  it("does not extract anything when the main process refuses the reservation", async () => {
    const user = userEvent.setup()
    const acquireLease = vi.fn<BridgeAPI["installationActivity"]["acquireLease"]>(async () => ({ ok: false, reason: "busy" }))
    const extractOnPath = vi.fn<BridgeAPI["pathsManager"]["extractOnPath"]>(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      installationActivity: { acquireLease },
      pathsManager: { checkPathExists: vi.fn(async () => true), movePath: vi.fn(async () => true), deletePath: vi.fn(async () => true), extractOnPath, changePerms: vi.fn(async () => true) }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")
    await user.click(screen.getByTitle("Restore"))

    await waitFor(() => expect(acquireLease).toHaveBeenCalledTimes(1))
    expect(extractOnPath).not.toHaveBeenCalled()
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

  it("disables the row trash button while a deletion is in flight", async () => {
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

    // Acquire the row's trash button. Before deletion it must be enabled.
    const trashButton = await screen.findByTitle("Delete")
    expect(trashButton.hasAttribute("disabled")).toBe(false)

    // Start the first deletion through the confirm dialog.
    await user.click(trashButton)
    await screen.findByText("Are you sure you want to delete this Backup?")
    const confirmButtons = screen.getAllByTitle("Delete")
    await user.click(confirmButtons[confirmButtons.length - 1]!)

    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))

    // While the deletion is in flight, the row trash button must be disabled.
    // This assertion fails on dev (where _deleting is never set) and passes on
    // this branch (where configDispatch sets _deleting: true before the call).
    await waitFor(() => {
      const buttons = screen.getAllByRole("button")
      const disabledButtons = buttons.filter((btn) => btn.hasAttribute("disabled"))
      expect(disabledButtons.length).toBeGreaterThan(0)
    })

    resolveDelete(true)
    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))
  })

  it("clears the deleting state when the archive deletion fails", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        // The archive is still on disk, so the refusal is a real one: a path
        // the host cannot find counts as deleted (see backupDeletion.ts).
        checkPathExists: vi.fn(async () => true),
        deletePath,
        extractOnPath: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Delete"))
    await screen.findByText("Are you sure you want to delete this Backup?")
    await user.click(screen.getAllByTitle("Delete")[1]!)
    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))
    await screen.findByTitle("Delete")

    await user.click(screen.getByTitle("Delete"))
    await screen.findByText("Are you sure you want to delete this Backup?")
    await user.click(screen.getAllByTitle("Delete")[1]!)
    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(2))
  })

  describe("an Installation whose folder holds another managed folder (#713)", () => {
    it.each([
      ["another Installation", { installations: [anInstallationWithBackup(), { ...anInstallationWithBackup(), id: "install-b", name: "Install B", path: "/games/a/b", backups: [] }] }, "/games/a/b"],
      ["the Backups folder", { installations: [anInstallationWithBackup()], backupsFolder: "/games/a/Backups" }, "/games/a/Backups"],
      ["the Installations folder", { installations: [anInstallationWithBackup()], defaultInstallationsFolder: "/games/a/Installations" }, "/games/a/Installations"],
      ["another Installation on the same folder", { installations: [anInstallationWithBackup(), { ...anInstallationWithBackup(), id: "install-b", name: "Install B", backups: [] }] }, "/games/a"]
    ])("says which folder to move when it holds %s, before extracting anything", async (_name, config, held) => {
      const user = userEvent.setup()
      const extractOnPath = vi.fn(async () => true)
      installMockWindowApi({
        configManager: { getConfig: vi.fn(async () => createMockConfig(config as Partial<ConfigType>)) },
        pathsManager: { checkPathExists: vi.fn(async () => true), movePath: vi.fn(async () => true), deletePath: vi.fn(async () => true), extractOnPath, changePerms: vi.fn(async () => true) }
      })

      renderManageBackups("install-a")
      await user.click(await screen.findByTitle("Restore Backup"))
      await user.click(await screen.findByTitle("Restore"))

      expect(await screen.findByText(new RegExp(`holds ${held.replaceAll("/", "\\/")}, which the launcher also manages`))).toBeTruthy()
      expect(extractOnPath).not.toHaveBeenCalled()
    })
  })
})
