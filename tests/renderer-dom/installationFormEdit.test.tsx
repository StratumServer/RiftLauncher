import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
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

// Only 1.22.6 installed; the Installation under test still points at 1.19.8, the way a
// config looks right after that version was uninstalled (#118).
const GAME_VERSIONS_WITHOUT_1_19_8: GameVersionType[] = [{ version: "1.22.6", path: "/versions/1.22.6" }]
const ORPHAN_WARNING = "This Installation's VS Version (1.19.8) is not installed anymore. Install it again or pick another one. Saving without picking one keeps it as it is."
const UNSET_WARNING = "This Installation has no VS Version set. Pick one to set it. Saving without picking one leaves it unset."
const VERSION_LEFT_UNCHANGED = "Everything else was saved, but this Installation still has no installed VS Version!"

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
    expect(screen.queryByText(/is not installed anymore/)).toBeNull()
  })

  it("renders the form when a registered VS Version string is not valid semver", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            // What a player gets from "look for a version" when the game answered `-v` with more
            // than a bare number: the string is stored as printed, and sorting it used to throw
            // out of the picker and leave the page blank.
            gameVersions: [
              { version: "1.20.0", path: "/versions/1.20.0" },
              { version: "Vintage Story 1.21.0", path: "/games/vintagestory", linked: true }
            ],
            installations: [anInstallation({ version: "1.20.0" })]
          })
        )
      }
    })

    await openEditInstallation("install-a")

    await screen.findByDisplayValue("Install A")
    expect(screen.getByText("1.20.0")).toBeTruthy()
    expect(screen.getByText("Vintage Story 1.21.0")).toBeTruthy()
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

    expect(await screen.findByText("Installation edited successfully!")).toBeTruthy()
    expect(await screen.findByText("installations-list")).toBeTruthy()
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

  it("leaves the version unselected and warns when the Installation's VS Version is gone", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: GAME_VERSIONS_WITHOUT_1_19_8, installations: [anInstallation({ version: "1.19.8" })] }))
      }
    })

    await openEditInstallation("install-a")

    await screen.findByDisplayValue("Install A")
    await screen.findByText(ORPHAN_WARNING)

    const unselectedVersionRow = screen.getByText("1.22.6").closest("li")
    expect(unselectedVersionRow?.className).not.toContain("border-vs")
  })

  it("warns without naming a version when the Installation has no VS Version set at all", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: GAME_VERSIONS, installations: [anInstallation({ version: "" })] }))
      }
    })

    await openEditInstallation("install-a")

    await screen.findByDisplayValue("Install A")
    // "" is what configManager normalizes a missing version to, and it used to render no
    // banner at all because the guard tested truthiness.
    await screen.findByText(UNSET_WARNING)
    expect(screen.queryByText(/is not installed anymore/)).toBeNull()

    expect(screen.getByText("1.20.0").closest("li")?.className).not.toContain("border-vs")
    expect(screen.getByText("1.19.0").closest("li")?.className).not.toContain("border-vs")
  })

  it("saves the rest of the form and leaves an orphaned VS Version untouched", async () => {
    const user = userEvent.setup()
    const savedConfigs: ConfigType[] = []
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: GAME_VERSIONS_WITHOUT_1_19_8, installations: [anInstallation({ version: "1.19.8" })] })),
        saveConfig: vi.fn(async (config: ConfigType) => {
          savedConfigs.push(config)
          return { ok: true } as SaveConfigResult
        })
      }
    })

    await openEditInstallation("install-a")

    const nameInput = await screen.findByDisplayValue("Install A")
    await user.clear(nameInput)
    await user.type(nameInput, "Renamed Install")
    await user.click(screen.getByTitle("Save"))

    await screen.findByText("Installation edited successfully!")
    await screen.findByText(VERSION_LEFT_UNCHANGED)
    await screen.findByText("installations-list")

    // The rename lands, the version does not move off the one the Installation already had.
    await waitFor(() => expect(savedConfigs.some((config) => config.installations[0]?.name === "Renamed Install")).toBe(true))
    expect(savedConfigs.every((config) => config.installations.every((installation) => installation.version === "1.19.8"))).toBe(true)
  })

  it("saves the rest of the form for an Installation with no VS Version set and never writes one", async () => {
    const user = userEvent.setup()
    const savedConfigs: ConfigType[] = []
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: GAME_VERSIONS, installations: [anInstallation({ version: "" })] })),
        saveConfig: vi.fn(async (config: ConfigType) => {
          savedConfigs.push(config)
          return { ok: true } as SaveConfigResult
        })
      }
    })

    await openEditInstallation("install-a")

    const nameInput = await screen.findByDisplayValue("Install A")
    await user.clear(nameInput)
    await user.type(nameInput, "Renamed Install")
    await user.click(screen.getByTitle("Save"))

    await screen.findByText("Installation edited successfully!")
    await screen.findByText(VERSION_LEFT_UNCHANGED)
    await screen.findByText("installations-list")

    await waitFor(() => expect(savedConfigs.some((config) => config.installations[0]?.name === "Renamed Install")).toBe(true))
    expect(savedConfigs.every((config) => config.installations.every((installation) => installation.version === ""))).toBe(true)
  })

  it("saves once the player picks a VS Version that is still installed", async () => {
    const user = userEvent.setup()
    const savedConfigs: ConfigType[] = []
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: GAME_VERSIONS_WITHOUT_1_19_8, installations: [anInstallation({ version: "1.19.8" })] })),
        saveConfig: vi.fn(async (config: ConfigType) => {
          savedConfigs.push(config)
          return { ok: true } as SaveConfigResult
        })
      }
    })

    await openEditInstallation("install-a")

    await screen.findByDisplayValue("Install A")
    await user.click(screen.getByText("1.22.6"))
    await user.click(screen.getByTitle("Save"))

    await screen.findByText("Installation edited successfully!")
    await screen.findByText("installations-list")
    await waitFor(() => expect(savedConfigs.some((config) => config.installations[0]?.version === "1.22.6")).toBe(true))
    expect(screen.queryByText(VERSION_LEFT_UNCHANGED)).toBeNull()
  })
})
