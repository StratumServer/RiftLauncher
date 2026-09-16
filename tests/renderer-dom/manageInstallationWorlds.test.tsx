import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageInstallationWorlds from "@renderer/features/installations/pages/ManageInstallationWorlds"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(): InstallationType {
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
    worldBackups: [{ id: "backup-1", date: 1, path: "/backups/backup-1.tar.gz", worldName: "World.vcdbs" }],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: ""
  }
}

function renderWorlds(deleteWorld: BridgeAPI["worldsManager"]["delete"]): void {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
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

    expect(backupButton.disabled).toBe(true)
    expect(copyButton.disabled).toBe(true)
    expect(moveButton.disabled).toBe(true)
    expect(deleteButton.disabled).toBe(true)
    expect(restoreButton.disabled).toBe(true)
  })
})
