import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"

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

/** Renders the real page, not a stub: #127 is a display bug, worth proving against the actual component. */
function renderList(config: ConfigType): void {
  installMockWindowApi({ configManager: { getConfig: vi.fn(async () => config) } })

  renderWithProviders(
    <TaskProvider>
      <ListInstallations />
    </TaskProvider>,
    { route: "/installations" }
  )
}

describe("ListInstallations orphaned VS Version marker (#127)", () => {
  it("shows no warning for an Installation on a VS Version that is still installed", async () => {
    renderList(createMockConfig({ gameVersions: [{ version: "1.20.0", path: "/versions/1.20.0" }], installations: [anInstallation({ version: "1.20.0" })] }))

    await screen.findByText("Install A")
    expect(screen.queryByTitle("VS Version 1.20.0 not installed!")).toBeNull()
  })

  it("warns when an Installation's VS Version is no longer installed", async () => {
    renderList(createMockConfig({ gameVersions: [{ version: "1.22.6", path: "/versions/1.22.6" }], installations: [anInstallation({ version: "1.19.8" })] }))

    await screen.findByText("Install A")
    expect(screen.getByTitle("VS Version 1.19.8 not installed!")).toBeTruthy()
  })
})
