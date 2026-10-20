import { describe, expect, it, vi } from "vitest"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Routes, Route } from "react-router-dom"

import AddInstallation from "@renderer/features/installations/pages/AddInstallation"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "granite",
    path: "/games/a",
    version: "1.20.0",
    gameVersionId: "gv-1",
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

/** AddInstallation navigates to /installations on success; a stub route stands in for the real list page. */
function renderAddInstallation(): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/installations/add" element={<AddInstallation />} />
        <Route path="/installations" element={<p>installations-list</p>} />
      </Routes>
      <NotificationsOverlay />
    </>,
    { route: "/installations/add" }
  )
}

describe("AddInstallation", () => {
  it("submits the default fields, adds the Installation and returns to the list", async () => {
    const user = userEvent.setup()
    const ensurePathExists = vi.fn(async () => true)
    const savedConfigs: ConfigType[] = []
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ defaultInstallationsFolder: "/installations", gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/versions/1.20.0" }] })),
        saveConfig: vi.fn(async (config: ConfigType) => {
          savedConfigs.push(config)
          return { ok: true } as SaveConfigResult
        })
      },
      pathsManager: { ensurePathExists }
    })

    renderAddInstallation()

    // The data folder auto-fills off the default name once gameVersions/config are loaded.
    await waitFor(() => expect((screen.getByPlaceholderText("Installation folder") as HTMLInputElement).value).not.toBe(""))

    // The version list only reaches its default selection once gameVersions has loaded
    // asynchronously, so the pinned flow selects a row explicitly like a real user would.
    await user.click(await screen.findByText("1.20.0"))

    await user.click(screen.getByTitle("Add"))

    await screen.findByText("Installation added successfully.")
    await screen.findByText("installations-list")
    await waitFor(() => expect(ensurePathExists).toHaveBeenCalled())
    await waitFor(() => expect(savedConfigs.some((config) => config.installations.some((installation) => installation.gameVersionId === "gv-1"))).toBe(true))
  })

  it("renders the form when a registered VS Version string is not valid semver", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            defaultInstallationsFolder: "/installations",
            gameVersions: [
              { id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/versions/1.20.0" },
              { id: "gv-2", label: "Vintage Story 1.21.0", version: "Vintage Story 1.21.0", path: "/games/vintagestory", linked: true }
            ]
          })
        )
      }
    })

    renderAddInstallation()

    // The default version is picked by sorting the list, so this page went blank on the same
    // string that took the edit form down.
    expect(await screen.findByText("1.20.0")).toBeTruthy()
    expect(screen.getByText("Vintage Story 1.21.0")).toBeTruthy()
  })

  it("notifies the name length failure and stays on the form when the name is too short", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ defaultInstallationsFolder: "/installations", gameVersions: [{ version: "1.20.0", path: "/versions/1.20.0" }] })) }
    })

    renderAddInstallation()

    await user.click(await screen.findByText("1.20.0"))

    const nameInput = screen.getByPlaceholderText("My New Installation")
    await user.clear(nameInput)
    await user.type(nameInput, "abc")

    await user.click(screen.getByTitle("Add"))

    await screen.findByText("Installation name must contain between 5 and 50 characters.")
    expect(screen.queryByText("installations-list")).toBeNull()
  })

  it("notifies the folder collision and stays on the form when the picked folder is already in use", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            defaultInstallationsFolder: "/installations",
            gameVersions: [{ version: "1.20.0", path: "/versions/1.20.0" }],
            installations: [anInstallation({ path: "/games/collision" })]
          })
        )
      },
      utils: { selectFolderDialog: vi.fn(async () => ["/games/collision"]) },
      pathsManager: { checkPathEmpty: vi.fn(async () => true) }
    })

    renderAddInstallation()

    await user.click(await screen.findByText("1.20.0"))

    await user.click(screen.getByTitle("Browse"))
    await waitFor(() => expect((screen.getByPlaceholderText("Installation folder") as HTMLInputElement).value).toBe("/games/collision"))

    await user.click(screen.getByTitle("Add"))

    await screen.findByText("That folder is already in use.")
    expect(screen.queryByText("installations-list")).toBeNull()
  })

  it("accepts a Backups max amount of 0 and saves the Installation with backups turned off", async () => {
    const user = userEvent.setup()
    const ensurePathExists = vi.fn(async () => true)
    const savedConfigs: ConfigType[] = []
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ defaultInstallationsFolder: "/installations", gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/versions/1.20.0" }] })),
        saveConfig: vi.fn(async (config: ConfigType) => {
          savedConfigs.push(config)
          return { ok: true } as SaveConfigResult
        })
      },
      pathsManager: { ensurePathExists }
    })

    renderAddInstallation()

    await waitFor(() => expect((screen.getByPlaceholderText("Installation folder") as HTMLInputElement).value).not.toBe(""))
    await user.click(await screen.findByText("1.20.0"))

    const backupsInput = screen.getByPlaceholderText("Backups max amount")
    await user.clear(backupsInput)
    await user.type(backupsInput, "0")
    expect((backupsInput as HTMLInputElement).value).toBe("0")

    await user.click(screen.getByTitle("Add"))

    await screen.findByText("Installation added successfully.")
    await screen.findByText("installations-list")
    await waitFor(() => expect(savedConfigs.some((config) => config.installations.some((installation) => installation.backupsLimit === 0))).toBe(true))
  })

  it("refuses a negative or non-integer Backups max amount and stays on the form", async () => {
    const user = userEvent.setup()
    const ensurePathExists = vi.fn(async () => true)
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ defaultInstallationsFolder: "/installations", gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/versions/1.20.0" }] })),
        saveConfig
      },
      pathsManager: { ensurePathExists }
    })

    renderAddInstallation()

    await waitFor(() => expect((screen.getByPlaceholderText("Installation folder") as HTMLInputElement).value).not.toBe(""))
    await user.click(await screen.findByText("1.20.0"))

    const backupsInput = screen.getByPlaceholderText("Backups max amount")
    fireEvent.change(backupsInput, { target: { value: "-1" } })
    await user.click(screen.getByTitle("Add"))

    await screen.findByText("Fill in every field before saving.")
    expect(screen.queryByText("installations-list")).toBeNull()

    fireEvent.change(backupsInput, { target: { value: "1.5" } })
    await user.click(screen.getByTitle("Add"))

    expect(screen.queryByText("installations-list")).toBeNull()

    // With backupsLimit restored to 0, an empty name still refuses with missingFields.
    fireEvent.change(backupsInput, { target: { value: "0" } })
    const nameInput = screen.getByPlaceholderText("My New Installation")
    await user.clear(nameInput)
    await user.click(screen.getByTitle("Add"))

    expect(screen.queryByText("installations-list")).toBeNull()
    expect(ensurePathExists).not.toHaveBeenCalled()
    expect(saveConfig).not.toHaveBeenCalled()
  })
})
