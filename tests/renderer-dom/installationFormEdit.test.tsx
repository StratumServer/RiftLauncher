import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Routes, Route, Link } from "react-router-dom"

import EditInstallation from "@renderer/features/installations/pages/EditInstallation"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { useInstallations } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "granite",
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

const GAME_VERSIONS: GameVersionType[] = [
  { version: "1.20.0", path: "/versions/1.20.0" },
  { version: "1.19.0", path: "/versions/1.19.0" }
]

/**
 * Stands in for ListInstallations: EditInstallation's post-submit navigation target.
 */
function InstallationsListStub(): JSX.Element {
  const installations = useInstallations()
  return (
    <div>
      <p>installations-list</p>
      {installations.map((installation) => (
        <Link key={installation.id} to={`/installations/edit/${installation.id}`}>{`open-${installation.id}`}</Link>
      ))}
    </div>
  )
}

/**
 * Deep-links straight into the edit route, the same way a bookmark or a restored tab would: the
 * page mounts before ConfigProvider's async `getConfig()` resolves, so the Installation lookup has
 * to pick up the config once it lands rather than only ever finding it already there (#58).
 */
async function openEditInstallation(installationId: string): Promise<void> {
  renderWithProviders(
    <>
      <Routes>
        <Route path="/installations" element={<InstallationsListStub />} />
        <Route path="/installations/edit/:id" element={<EditInstallation />} />
      </Routes>
      <NotificationsOverlay />
    </>,
    { route: `/installations/edit/${installationId}` }
  )
}

describe("EditInstallation", () => {
  it("prefills the form with the found Installation's fields", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            gameVersions: GAME_VERSIONS,
            installations: [
              anInstallation({
                name: "Existing Install",
                icon: "granite",
                version: "1.20.0",
                startParams: "--foo",
                backupsLimit: 5,
                backupsAuto: true,
                compressionLevel: 8,
                mesaGlThread: true,
                envVars: "FOO=bar"
              })
            ]
          })
        )
      }
    })

    await openEditInstallation("install-a")

    await screen.findByDisplayValue("Existing Install")
    expect(screen.getByText("Granite")).toBeTruthy()

    // The Advanced group starts collapsed; open it to reach startParams/mesaGlThread/envVars.
    await user.click(screen.getByText("Advanced"))

    expect(screen.getByDisplayValue("--foo")).toBeTruthy()
    expect(screen.getByDisplayValue("5")).toBeTruthy()
    expect(screen.getByDisplayValue("8")).toBeTruthy()
    expect(screen.getByDisplayValue("FOO=bar")).toBeTruthy()

    const backupsAutoToggle = screen.getByTitle("Toggle on to make an automatic Backup before playing")
    expect(backupsAutoToggle.getAttribute("aria-checked")).toBe("true")

    const mesaGlThreadToggle = screen.getByTitle("Enable to run the game with mesa_glthread. This may boost the performance on some Linux systems.")
    expect(mesaGlThreadToggle.getAttribute("aria-checked")).toBe("true")

    const selectedVersionRow = screen.getByText("1.20.0").closest("li")
    expect(selectedVersionRow?.className).toContain("border-vs")
  })

  it("shows the not-found message instead of the form for an unknown id", async () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) } })

    renderWithProviders(
      <Routes>
        <Route path="/installations/edit/:id" element={<EditInstallation />} />
      </Routes>,
      { route: "/installations/edit/does-not-exist" }
    )

    await screen.findByText("Installation not found!")
    expect(screen.queryByText("Install A")).toBeNull()
  })

  it("submits the edited fields, updates the Installation and returns to the list", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: GAME_VERSIONS, installations: [anInstallation()] })) }
    })

    await openEditInstallation("install-a")

    const nameInput = await screen.findByDisplayValue("Install A")
    await user.clear(nameInput)
    await user.type(nameInput, "Renamed Install")

    await user.click(screen.getByTitle("Save"))

    await screen.findByText("Installation edited successfully!")
    await screen.findByText("installations-list")
  })

  it("notifies the name length failure and stays on the form when the name is too short", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: GAME_VERSIONS, installations: [anInstallation()] })) }
    })

    await openEditInstallation("install-a")

    const nameInput = await screen.findByDisplayValue("Install A")
    await user.clear(nameInput)
    await user.type(nameInput, "abc")

    await user.click(screen.getByTitle("Save"))

    await screen.findByText("Installation name must contain between 5 and 50 characters!")
    expect(screen.queryByText("installations-list")).toBeNull()
  })

  it("blocks editing while the Installation is playing", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: GAME_VERSIONS, installations: [anInstallation({ _playing: true })] }))
      }
    })

    await openEditInstallation("install-a")

    await screen.findByDisplayValue("Install A")
    await user.click(screen.getByTitle("Save"))

    await screen.findByText("You can't edit an Installation while playing it!")
    expect(screen.queryByText("installations-list")).toBeNull()
  })
})
