import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageInstallationWorlds from "@renderer/features/installations/pages/ManageInstallationWorlds"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import i18n, { changeLanguage } from "@renderer/i18n"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(worldBackups: WorldBackupType[] = [{ id: "backup-1", date: 1, path: "/backups/backup-1.tar.gz", worldName: "World.vcdbs" }]): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "",
    path: "/games/a",
    version: "1.22.7",
    gameVersionId: "version-a",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    worldBackups,
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: ""
  }
}

function renderWorlds(
  deleteWorld: BridgeAPI["worldsManager"]["delete"],
  restoreWorld: BridgeAPI["worldsManager"]["restore"] = vi.fn(async () => ({ ok: true as const })),
  worldBackups?: WorldBackupType[],
  deleteBackup: BridgeAPI["worldsManager"]["deleteBackup"] = vi.fn(async () => ({ ok: true as const }))
): void {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation(worldBackups)] })) },
    worldsManager: {
      list: vi.fn(async () => ({
        ok: true as const,
        worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 0 }]
      })),
      delete: deleteWorld,
      deleteBackup,
      restore: restoreWorld
    }
  })

  renderWithProviders(
    <>
      <NotificationsOverlay />
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>
    </>,
    { route: "/installations/worlds/install-a" }
  )
}

describe("ManageInstallationWorlds deletion confirmation", () => {
  it("keeps deletion disabled for a mismatched world name", async () => {
    const user = userEvent.setup()
    const deleteWorld = vi.fn<BridgeAPI["worldsManager"]["delete"]>(async () => ({ ok: true }))
    renderWorlds(deleteWorld)

    const deleteButton = await screen.findByTitle("Delete")
    await user.click(deleteButton)

    const dialog = await screen.findByRole("dialog")
    const nameInput = within(dialog).getByLabelText("Type World.vcdbs to permanently delete this world.")
    const confirmButton = within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement
    expect(deleteWorld).not.toHaveBeenCalled()
    expect(confirmButton.disabled).toBe(true)

    await user.type(nameInput, "world.vcdbs")

    expect(confirmButton.disabled).toBe(true)
    expect(deleteWorld).not.toHaveBeenCalled()
  })

  it("enables deletion only after the exact world name is entered", async () => {
    const user = userEvent.setup()
    const deleteWorld = vi.fn<BridgeAPI["worldsManager"]["delete"]>(async () => ({ ok: true }))
    renderWorlds(deleteWorld)

    await user.click(await screen.findByTitle("Delete"))

    const dialog = await screen.findByRole("dialog")
    const nameInput = within(dialog).getByLabelText("Type World.vcdbs to permanently delete this world.")
    const confirmButton = within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement
    await user.type(nameInput, "World.vcdbs")

    expect(confirmButton.disabled).toBe(false)
    await user.click(confirmButton)

    await waitFor(() => expect(deleteWorld).toHaveBeenCalledWith("install-a", "World.vcdbs"))
  })

  it("does not delete when the PopupDialogPanel is cancelled", async () => {
    const user = userEvent.setup()
    const deleteWorld = vi.fn<BridgeAPI["worldsManager"]["delete"]>(async () => ({ ok: true }))
    renderWorlds(deleteWorld)

    const deleteButton = await screen.findByTitle("Delete")
    await user.click(deleteButton)
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByRole("textbox"), "stale input")
    await user.click(within(dialog).getByTitle("Cancel"))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(deleteWorld).not.toHaveBeenCalled()

    await user.click(await screen.findByTitle("Delete"))
    const reopenedDialog = await screen.findByRole("dialog")
    expect((within(reopenedDialog).getByRole("textbox") as HTMLInputElement).value).toBe("")
    expect((within(reopenedDialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("does not delete the world when the optional backup prompt is cancelled", async () => {
    const user = userEvent.setup()
    const deleteWorld = vi.fn<BridgeAPI["worldsManager"]["delete"]>(async () => ({ ok: true }))
    renderWorlds(deleteWorld, undefined, [])

    await user.click(await screen.findByTitle("Delete"))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByRole("textbox"), "World.vcdbs")
    await user.click(within(dialog).getByRole("button", { name: "Delete" }))
    const backupDialog = await screen.findByRole("dialog")
    await user.click(within(backupDialog).getByRole("button", { name: "Cancel" }))

    expect(deleteWorld).not.toHaveBeenCalled()
  })

  it("keeps the world when the offered backup fails", async () => {
    const user = userEvent.setup()
    const deleteWorld = vi.fn<BridgeAPI["worldsManager"]["delete"]>(async () => ({ ok: true }))
    const backupWorld = vi.fn<BridgeAPI["worldsManager"]["backup"]>(async () => ({ ok: false, reason: "operation-failed" }))
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation([])] })) },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 0 }]
        })),
        backup: backupWorld,
        delete: deleteWorld
      }
    })

    renderWithProviders(
      <>
        <NotificationsOverlay />
        <Routes>
          <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
        </Routes>
      </>,
      { route: "/installations/worlds/install-a" }
    )

    await user.click(await screen.findByTitle("Delete"))
    const nameDialog = await screen.findByRole("dialog")
    await user.type(within(nameDialog).getByRole("textbox"), "World.vcdbs")
    await user.click(within(nameDialog).getByRole("button", { name: "Delete" }))

    const offer = await screen.findByText("There is no backup for World.vcdbs. Create one before deleting it?")
    await user.click(within(offer.closest("div[role=dialog]") as HTMLElement).getByRole("button", { name: "Back up this world" }))

    await waitFor(() => expect(backupWorld).toHaveBeenCalledWith("install-a", "World.vcdbs"))
    expect(await screen.findByText("The world operation failed. Nothing else was changed.")).not.toBeNull()
    expect(deleteWorld).not.toHaveBeenCalled()
  })

  it("backs the world up before deleting it when the offer is confirmed", async () => {
    const user = userEvent.setup()
    const order: string[] = []
    const deleteWorld = vi.fn<BridgeAPI["worldsManager"]["delete"]>(async () => {
      order.push("delete")
      return { ok: true }
    })
    const backupWorld = vi.fn<BridgeAPI["worldsManager"]["backup"]>(async () => {
      order.push("backup")
      return { ok: true, backup: { id: "backup-new", date: 2, path: "/backups/backup-new.tar.gz", worldName: "World.vcdbs" } }
    })
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation([])] })) },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 0 }]
        })),
        backup: backupWorld,
        delete: deleteWorld
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    await user.click(await screen.findByTitle("Delete"))
    const nameDialog = await screen.findByRole("dialog")
    await user.type(within(nameDialog).getByRole("textbox"), "World.vcdbs")
    await user.click(within(nameDialog).getByRole("button", { name: "Delete" }))

    const offer = await screen.findByText("There is no backup for World.vcdbs. Create one before deleting it?")
    expect(deleteWorld).not.toHaveBeenCalled()
    await user.click(within(offer.closest("div[role=dialog]") as HTMLElement).getByRole("button", { name: "Back up this world" }))

    await waitFor(() => expect(deleteWorld).toHaveBeenCalledWith("install-a", "World.vcdbs"))
    expect(backupWorld).toHaveBeenCalledWith("install-a", "World.vcdbs")
    expect(order).toEqual(["backup", "delete"])
  })

  it("does not treat a backup of a differently cased name as a backup of this world", async () => {
    const user = userEvent.setup()
    const deleteWorld = vi.fn<BridgeAPI["worldsManager"]["delete"]>(async () => ({ ok: true }))
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation([{ id: "backup-lower", date: 1, path: "/backups/backup-lower.tar.gz", worldName: "world.vcdbs" }])] }))
      },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 0 }]
        })),
        delete: deleteWorld
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    expect((await screen.findAllByText("World.vcdbs")).length).toBe(1)
    expect(screen.getByText("world.vcdbs")).not.toBeNull()
    expect(screen.getAllByTitle("Restore").length).toBe(1)

    await user.click(await screen.findByTitle("Delete"))
    const nameDialog = await screen.findByRole("dialog")
    await user.type(within(nameDialog).getByRole("textbox"), "World.vcdbs")
    await user.click(within(nameDialog).getByRole("button", { name: "Delete" }))

    expect(await screen.findByText("There is no backup for World.vcdbs. Create one before deleting it?")).not.toBeNull()
    expect(deleteWorld).not.toHaveBeenCalled()
  })

  it("keeps the empty-state notice above the list backdrop blur", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation([])] })) },
      worldsManager: {
        list: vi.fn(async () => ({ ok: true as const, worlds: [] })),
        delete: vi.fn(async () => ({ ok: true as const }))
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    const notice = await screen.findByText("No worlds found in this Installation.")
    expect(notice.className).toContain("relative")
  })

  it("keeps the reloading notice above the list backdrop blur", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation([])] })) },
      worldsManager: {
        list: vi.fn<BridgeAPI["worldsManager"]["list"]>(() => new Promise(() => {})),
        delete: vi.fn(async () => ({ ok: true as const }))
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    const notice = await screen.findByText("Reloading")
    expect(notice.className).toContain("relative")
  })

  it("reports a rejected restore instead of leaving an unhandled promise", async () => {
    const user = userEvent.setup()
    const restoreWorld = vi.fn<BridgeAPI["worldsManager"]["restore"]>(async () => {
      throw new Error("restore failed")
    })
    renderWorlds(
      vi.fn(async () => ({ ok: true as const })),
      restoreWorld
    )

    await user.click(await screen.findByTitle("Restore"))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Restore" }))

    expect(restoreWorld).toHaveBeenCalledWith("install-a", "backup-1")
  })

  it("disables world mutation buttons while the installation is playing", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [{ ...anInstallation(), _playing: true }] })) },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 1 }]
        })),
        delete: vi.fn(async () => ({ ok: true as const }))
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    const backupButton = (await screen.findByRole("button", { name: "Back up this world" })) as HTMLButtonElement
    const copyButton = (await screen.findByRole("button", { name: "Copy world" })) as HTMLButtonElement
    const moveButton = (await screen.findByRole("button", { name: "Move world" })) as HTMLButtonElement
    const deleteButton = (await screen.findByRole("button", { name: "Delete" })) as HTMLButtonElement
    const restoreButton = (await screen.findByRole("button", { name: "Restore" })) as HTMLButtonElement
    const deleteBackupButton = (await screen.findByRole("button", { name: "Delete backup" })) as HTMLButtonElement

    expect(backupButton.disabled).toBe(true)
    expect(copyButton.disabled).toBe(true)
    expect(moveButton.disabled).toBe(true)
    expect(deleteButton.disabled).toBe(true)
    expect(restoreButton.disabled).toBe(true)
    expect(deleteBackupButton.disabled).toBe(true)
  })
  it("disables transfer buttons for a playing target installation", async () => {
    const second = { ...anInstallation(), id: "install-b", name: "Install B", path: "/games/b", gameVersionId: "version-b", _playing: true }
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation(), second] })) },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 0 }]
        })),
        delete: vi.fn(async () => ({ ok: true as const }))
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    const copyButton = await screen.findByRole("button", { name: "Copy world" })
    const moveButton = await screen.findByRole("button", { name: "Move world" })
    const backupButton = await screen.findByRole("button", { name: "Back up this world" })
    const select = await screen.findByRole("combobox")
    await userEvent.selectOptions(select, "install-b")

    await waitFor(() => {
      expect((copyButton as HTMLButtonElement).disabled).toBe(true)
      expect((moveButton as HTMLButtonElement).disabled).toBe(true)
      expect((backupButton as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it("renders one row per backup-only world name even with several archives", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            installations: [
              {
                ...anInstallation(),
                worldBackups: [
                  { id: "b1", date: 3, path: "/backups/b1.tar.gz", worldName: "Gone.vcdbs" },
                  { id: "b2", date: 1, path: "/backups/b2.tar.gz", worldName: "Gone.vcdbs" }
                ]
              }
            ]
          })
        )
      },
      worldsManager: {
        list: vi.fn(async () => ({ ok: true as const, worlds: [] })),
        delete: vi.fn(async () => ({ ok: true as const }))
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    expect((await screen.findAllByText("Gone.vcdbs")).length).toBe(1)
    expect(screen.getAllByTitle("Restore").length).toBe(2)
  })

  it("prompts before backing up a world directly from the list", async () => {
    const user = userEvent.setup()
    const backupWorld = vi.fn<BridgeAPI["worldsManager"]["backup"]>(async () => ({
      ok: true,
      backup: { id: "backup-direct", date: 1, path: "/backups/backup-direct.tar.gz", worldName: "World.vcdbs" }
    }))
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation([])] })) },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 0 }]
        })),
        backup: backupWorld,
        delete: vi.fn(async () => ({ ok: true as const }))
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    await user.click(await screen.findByTitle("Back up this world"))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Back up World.vcdbs now?")).not.toBeNull()
    expect(backupWorld).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: "Back up this world" }))
    await waitFor(() => expect(backupWorld).toHaveBeenCalledWith("install-a", "World.vcdbs"))
  })

  it("marks a different-version target before transfer and keeps the copied world name in the result", async () => {
    const user = userEvent.setup()
    const second = { ...anInstallation(), id: "install-b", name: "Install B", path: "/games/b", version: "1.22.6", gameVersionId: "version-b" }
    const transferWorld = vi.fn<BridgeAPI["worldsManager"]["transfer"]>(async () => ({
      ok: true,
      targetWorldName: "World (1).vcdbs",
      warning: "different-version"
    }))
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation(), second] })) },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 0 }]
        })),
        transfer: transferWorld,
        delete: vi.fn(async () => ({ ok: true as const }))
      }
    })

    renderWithProviders(
      <>
        <NotificationsOverlay />
        <Routes>
          <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
        </Routes>
      </>,
      { route: "/installations/worlds/install-a" }
    )

    const select = await screen.findByRole("combobox")
    await userEvent.selectOptions(select, "install-b")
    expect(screen.getByRole("option", { name: "Install B (different version)" })).not.toBeNull()
    expect(screen.getByText("A world opened with a newer Vintage Story version usually will not work with an older one.")).not.toBeNull()

    await user.click(await screen.findByTitle("Copy world"))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Transfer World.vcdbs to Install B?")).not.toBeNull()
    expect(transferWorld).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: "Copy world" }))
    await waitFor(() => expect(transferWorld).toHaveBeenCalledWith("install-a", "World.vcdbs", "install-b", "copy"))
    expect(await screen.findByText("World transferred as World (1).vcdbs between different Vintage Story versions.")).not.toBeNull()
  })

  it("renders singular and plural backup counts according to the plural family", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            installations: [
              anInstallation([
                { id: "b1", date: 1, path: "/backups/b1.tar.gz", worldName: "Single.vcdbs" },
                { id: "b2", date: 2, path: "/backups/b2.tar.gz", worldName: "Multi.vcdbs" },
                { id: "b3", date: 3, path: "/backups/b3.tar.gz", worldName: "Multi.vcdbs" }
              ])
            ]
          })
        )
      },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [
            { name: "Single.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 1 },
            { name: "Multi.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 2 }
          ]
        })),
        delete: vi.fn(async () => ({ ok: true as const }))
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    expect(await screen.findByText(/1 backup$/)).not.toBeNull()
    expect(await screen.findByText(/2 backups$/)).not.toBeNull()
  })

  it("shows a world name with special characters as plain text, not HTML entities, in the delete and transfer prompts", async () => {
    const user = userEvent.setup()
    const specialName = `Bob's World & "Co" <1>.vcdbs`
    const second = { ...anInstallation(), id: "install-b", name: "Install B", path: "/games/b", gameVersionId: "version-b" }
    const transferWorld = vi.fn<BridgeAPI["worldsManager"]["transfer"]>(async () => ({ ok: true, targetWorldName: specialName }))
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation([]), second] })) },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: specialName, size: 5, lastModified: 1, isDefault: false, backupCount: 0 }]
        })),
        transfer: transferWorld,
        delete: vi.fn(async () => ({ ok: true as const }))
      }
    })

    renderWithProviders(
      <>
        <NotificationsOverlay />
        <Routes>
          <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
        </Routes>
      </>,
      { route: "/installations/worlds/install-a" }
    )

    // The delete prompt states the real name, and typing that real name (not the escaped one) enables Delete.
    await user.click(await screen.findByTitle("Delete"))
    const nameDialog = await screen.findByRole("dialog")
    const nameInput = within(nameDialog).getByLabelText(`Type ${specialName} to permanently delete this world.`)
    const confirmDeleteButton = within(nameDialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement
    expect(confirmDeleteButton.disabled).toBe(true)
    await user.type(nameInput, specialName)
    expect(confirmDeleteButton.disabled).toBe(false)
    await user.click(within(nameDialog).getByTitle("Cancel"))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    // The transfer confirmation and its result toast state the real names too.
    const select = await screen.findByRole("combobox")
    await userEvent.selectOptions(select, "install-b")
    await user.click(await screen.findByTitle("Copy world"))
    const transferDialog = await screen.findByRole("dialog")
    expect(within(transferDialog).getByText(`Transfer ${specialName} to Install B?`)).not.toBeNull()
    await user.click(within(transferDialog).getByRole("button", { name: "Copy world" }))

    await waitFor(() => expect(transferWorld).toHaveBeenCalledWith("install-a", specialName, "install-b", "copy"))
    expect(await screen.findByText(`World transferred as ${specialName}.`)).not.toBeNull()
  })

  it("never shows the no-backup offer beside a still-closing name dialog, and returns focus to Delete once the chain ends", async () => {
    const user = userEvent.setup()
    const deleteWorld = vi.fn<BridgeAPI["worldsManager"]["delete"]>(async () => ({ ok: true }))
    const backupWorld = vi.fn<BridgeAPI["worldsManager"]["backup"]>(async () => ({
      ok: true,
      backup: { id: "backup-new", date: 2, path: "/backups/backup-new.tar.gz", worldName: "World.vcdbs" }
    }))
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation([])] })) },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 0 }]
        })),
        backup: backupWorld,
        delete: deleteWorld
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    const deleteButton = await screen.findByTitle("Delete")
    await user.click(deleteButton)
    const nameDialog = await screen.findByRole("dialog")
    await user.type(within(nameDialog).getByRole("textbox"), "World.vcdbs")
    await user.click(within(nameDialog).getByRole("button", { name: "Delete" }))
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(1)

    // The offer only replaces the name dialog once that one has actually finished closing, so at
    // no point are both on screen fighting over the focus trap: exactly one dialog exists once it appears.
    const offerText = await screen.findByText("There is no backup for World.vcdbs. Create one before deleting it?")
    const offerDialog = offerText.closest('[role="dialog"]') as HTMLElement
    expect(offerDialog).not.toBeNull()
    expect(screen.queryAllByRole("dialog")).toHaveLength(1)
    await waitFor(() => expect(offerDialog.contains(document.activeElement)).toBe(true))

    await user.click(within(offerDialog).getByRole("button", { name: "Back up this world" }))
    await waitFor(() => expect(deleteWorld).toHaveBeenCalledWith("install-a", "World.vcdbs"))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(deleteButton))
  })

  it("prompts before deleting a world backup and does not delete when cancelled", async () => {
    const user = userEvent.setup()
    const deleteBackup = vi.fn<BridgeAPI["worldsManager"]["deleteBackup"]>(async () => ({ ok: true as const }))
    renderWorlds(
      vi.fn(async () => ({ ok: true as const })),
      undefined,
      undefined,
      deleteBackup
    )

    const deleteBackupButton = await screen.findByTitle("Delete backup")
    await user.click(deleteBackupButton)

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/Permanently delete this backup of World\.vcdbs from/)).not.toBeNull()
    expect(within(dialog).getByText("Deletion is not reversible so you'll not be able to restore your worlds, data and other info using this Backup anymore.")).not.toBeNull()

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(deleteBackup).not.toHaveBeenCalled()
  })

  it("deletes a world backup when confirmed and removes it from the list", async () => {
    const user = userEvent.setup()
    const deleteBackup = vi.fn<BridgeAPI["worldsManager"]["deleteBackup"]>(async () => ({ ok: true as const }))
    renderWorlds(
      vi.fn(async () => ({ ok: true as const })),
      undefined,
      undefined,
      deleteBackup
    )

    expect(await screen.findByTitle("Delete backup")).not.toBeNull()
    await user.click(await screen.findByTitle("Delete backup"))

    const dialog = await screen.findByRole("dialog")
    const confirmButton = within(dialog).getByRole("button", { name: "Delete" })
    await user.click(confirmButton)

    await waitFor(() => expect(deleteBackup).toHaveBeenCalledWith("install-a", "backup-1"))
    await waitFor(() => expect(screen.queryByTitle("Delete backup")).toBeNull())
  })

  it("shows consequence warning on backup confirmation when older backups will be pruned", async () => {
    const user = userEvent.setup()
    const backupWorld = vi.fn<BridgeAPI["worldsManager"]["backup"]>(async () => ({
      ok: true as const,
      backup: { id: "backup-new", date: 4, path: "/backups/backup-new.tar.gz", worldName: "World.vcdbs" },
      deletedBackupIds: ["backup-1"]
    }))
    const existing = [
      { id: "backup-3", date: 3, path: "/backups/backup-3.tar.gz", worldName: "World.vcdbs" },
      { id: "backup-2", date: 2, path: "/backups/backup-2.tar.gz", worldName: "World.vcdbs" },
      { id: "backup-1", date: 1, path: "/backups/backup-1.tar.gz", worldName: "World.vcdbs" }
    ]
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            installations: [{ ...anInstallation(existing), backupsLimit: 3 }]
          })
        )
      },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 3 }]
        })),
        delete: vi.fn(async () => ({ ok: true as const })),
        backup: backupWorld
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    await user.click(await screen.findByTitle("Back up this world"))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Back up World.vcdbs now?")).not.toBeNull()
    expect(within(dialog).getByText("The oldest backup of this world will be deleted to stay within the backup limit.")).not.toBeNull()
  })

  it("warns when deleting the last remaining copy of a world that has no live save", async () => {
    const user = userEvent.setup()
    const deleteBackup = vi.fn<BridgeAPI["worldsManager"]["deleteBackup"]>(async () => ({ ok: true as const }))
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            installations: [anInstallation([{ id: "backup-orphan", date: 1, path: "/backups/backup-orphan.tar.gz", worldName: "DeadWorld.vcdbs" }])]
          })
        )
      },
      worldsManager: {
        list: vi.fn(async () => ({
          ok: true as const,
          worlds: []
        })),
        delete: vi.fn(async () => ({ ok: true as const })),
        deleteBackup
      }
    })

    renderWithProviders(
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>,
      { route: "/installations/worlds/install-a" }
    )

    const deleteBackupButton = await screen.findByTitle("Delete backup")
    await user.click(deleteBackupButton)

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/This is the only remaining copy of this world\./)).not.toBeNull()
  })

  it("shows an error notification when delete backup fails", async () => {
    const user = userEvent.setup()
    const deleteBackup = vi.fn<BridgeAPI["worldsManager"]["deleteBackup"]>(async () => ({ ok: false as const, reason: "operation-failed" }))
    renderWorlds(
      vi.fn(async () => ({ ok: true as const })),
      undefined,
      undefined,
      deleteBackup
    )

    await user.click(await screen.findByTitle("Delete backup"))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Delete" }))

    await waitFor(() => expect(deleteBackup).toHaveBeenCalledWith("install-a", "backup-1"))
    expect(await screen.findByText("The world operation failed. Nothing else was changed.")).not.toBeNull()
    expect(screen.getByTitle("Delete backup")).not.toBeNull()
  })
})
it("does not refetch in a loop when listing fails", async () => {
  const list = vi.fn(async () => ({ ok: false as const, reason: "saves-unavailable" }))
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    worldsManager: {
      list,
      delete: vi.fn(async () => ({ ok: true as const }))
    }
  })

  renderWithProviders(
    <Routes>
      <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
    </Routes>,
    { route: "/installations/worlds/install-a" }
  )

  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(list).toHaveBeenCalledTimes(1)
})

/**
 * A crash or a power cut leaves the world's SQLite journal files, `-wal` and `-shm`, beside it in
 * Saves, and the main process refuses every change to that world while they are there (#692;
 * tests/ipc/worldsHandlers.test.ts pins the refusal with real files). Nothing has the world open
 * then, so the old answer, "This world is active. Close Vintage Story and try again.", sent the
 * player to close a game that was already closed. The refusal stays, and the sentence now names
 * both causes and both ways out, so this is what each action on the page shows for it.
 */
const JOURNAL_REFUSAL = [
  {
    language: "en-US",
    sentence: "This world is open in Vintage Story, or was not closed cleanly after a crash or a power cut. Close the game, or open the world in it once and quit normally, then try again."
  },
  {
    language: "fr-FR",
    sentence:
      "Ce monde est ouvert dans Vintage Story, ou n'a pas été fermé correctement après un plantage ou une coupure de courant. Fermez le jeu, ou ouvrez ce monde une fois dans le jeu et quittez-le normalement, puis réessayez."
  }
] as const

type Player = ReturnType<typeof userEvent.setup>

/** Opens a row action's confirmation and confirms it. The labels are read in the language on screen, so the same steps drive English and French. */
async function confirmRowAction(user: Player, key: string, fill?: (dialog: HTMLElement) => Promise<void>): Promise<void> {
  await user.click(await screen.findByTitle(i18n.t(key)))
  const dialog = await screen.findByRole("dialog")
  await fill?.(dialog)
  await user.click(within(dialog).getByRole("button", { name: i18n.t(key) }))
}

/** Each action that can come back "world-has-sidecars", the bridge call it makes, and the clicks that get there. Copy and move share one call site, so copy stands for both. */
const REFUSED_ACTIONS: { action: string; call: "backup" | "restore" | "transfer" | "delete"; run: (user: Player) => Promise<void> }[] = [
  { action: "backing up", call: "backup", run: (user) => confirmRowAction(user, "features.worlds.backup") },
  { action: "restoring", call: "restore", run: (user) => confirmRowAction(user, "generic.restore") },
  {
    action: "copying",
    call: "transfer",
    run: async (user) => {
      await user.selectOptions(await screen.findByRole("combobox"), "install-b")
      await confirmRowAction(user, "features.worlds.copy")
    }
  },
  { action: "deleting", call: "delete", run: (user) => confirmRowAction(user, "generic.delete", (dialog) => user.type(within(dialog).getByRole("textbox"), "World.vcdbs")) }
]

/** Manage Worlds for an Installation that is not running, whose one world the main process refuses to touch because its journal files are still there. */
function renderWorldWithLeftoverJournal(): MockedBridgeAPI {
  const refusal = { ok: false as const, reason: "world-has-sidecars" }
  const api = installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () =>
        createMockConfig({
          installations: [
            { ...anInstallation(), _playing: false },
            { ...anInstallation(), id: "install-b", name: "Install B", path: "/games/b", gameVersionId: "version-b" }
          ]
        })
      )
    },
    worldsManager: {
      list: vi.fn(async () => ({ ok: true as const, worlds: [{ name: "World.vcdbs", size: 5, lastModified: 1, isDefault: false, backupCount: 1 }] })),
      backup: vi.fn(async () => refusal),
      restore: vi.fn(async () => refusal),
      transfer: vi.fn(async () => refusal),
      delete: vi.fn(async () => refusal)
    }
  })

  renderWithProviders(
    <>
      <NotificationsOverlay />
      <Routes>
        <Route path="/installations/worlds/:id" element={<ManageInstallationWorlds />} />
      </Routes>
    </>,
    { route: "/installations/worlds/install-a" }
  )
  return api
}

describe.each(JOURNAL_REFUSAL)("a world left with its journal files and no game running, in $language (#692)", ({ language, sentence }) => {
  beforeEach(async () => {
    expect(await changeLanguage(language)).toBe(true)
    // After the test, which is after the cleanup that unmounts the page: a language switch on a
    // mounted page would re-render it outside act().
    onTestFinished(async () => {
      await changeLanguage("en-US")
    })
  })

  it.each(REFUSED_ACTIONS)("shows the sentence for a crash or a power cut when $action is refused", async ({ call, run }) => {
    const api = renderWorldWithLeftoverJournal()

    await run(userEvent.setup())

    expect(await screen.findByText(sentence)).not.toBeNull()
    expect(api.worldsManager[call]).toHaveBeenCalledTimes(1)
  })
})
