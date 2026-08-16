import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListInstallations from "@renderer/features/installations/pages/ListInstallations"
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
})
