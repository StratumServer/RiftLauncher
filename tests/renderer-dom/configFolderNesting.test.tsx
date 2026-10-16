/**
 * Folders that would share data with an Installation (#713).
 *
 * Restoring or deleting an Installation wipes its whole folder, so the add form and the Config
 * folder pickers refuse a folder inside one, or around one, with a notification that says why.
 */
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import AddInstallation from "@renderer/features/installations/pages/AddInstallation"
import ConfigPage from "@renderer/features/config/pages/ConfigPage"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const INSIDE = "That folder is inside an Installation. Restoring or deleting the Installation would erase it. Pick a folder outside every Installation."
const HOLDS = "That folder holds an Installation. Restoring or deleting the Installation would erase the backups. Pick a folder outside every Installation."
const NESTED =
  "That folder is inside or around another Installation, a VS Version or the Backups folder, or it is or holds the Installations or VS Versions folder. Restoring or deleting one would erase the other. Pick a separate folder."

const MAIN = { id: "main", name: "Main", path: "/data/Main", backups: [] }

function mockApi(picked: string, os: NodeJS.Platform = "linux", config: Partial<ConfigType> = {}): MockedBridgeAPI {
  return installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () =>
        createMockConfig({
          defaultInstallationsFolder: "/data/Installations",
          defaultVersionsFolder: "/data/Versions",
          backupsFolder: "/data/Backups",
          installations: [MAIN] as unknown as ConfigType["installations"],
          gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/versions/1.20.0" }],
          ...config
        })
      )
    },
    utils: { getOs: vi.fn(async () => os), selectFolderDialog: vi.fn(async () => [picked]) },
    pathsManager: { checkPathEmpty: vi.fn(async () => true) }
  })
}

async function addInstallationAt(picked: string, os: NodeJS.Platform = "linux", config: Partial<ConfigType> = {}): Promise<MockedBridgeAPI> {
  const user = userEvent.setup()
  const api = mockApi(picked, os, config)

  renderWithProviders(
    <>
      <Routes>
        <Route path="/installations/add" element={<AddInstallation />} />
        <Route path="/installations" element={<p>installations-list</p>} />
      </Routes>
      <NotificationsOverlay />
    </>,
    { route: "/installations/add" }
  )

  await waitFor(() => expect((screen.getByPlaceholderText("Installation folder") as HTMLInputElement).value).not.toBe(""))
  await user.click(await screen.findByText("1.20.0"))
  await user.click(screen.getByTitle("Browse"))
  await waitFor(() => expect((screen.getByPlaceholderText("Installation folder") as HTMLInputElement).value).toBe(picked))
  await user.click(screen.getByTitle("Add"))
  return api
}

describe("AddInstallation, a folder that shares data with another", () => {
  it.each([
    ["inside another Installation", "/data/Main/Modded"],
    ["around another Installation", "/data"],
    ["inside the Backups folder", "/data/Backups/Main2"],
    ["around a VS Version", "/versions"]
  ])("refuses a folder %s and adds nothing", async (_name, picked) => {
    const api = await addInstallationAt(picked)

    expect(await screen.findByText(NESTED)).toBeTruthy()
    expect(api.pathsManager.ensurePathExists).not.toHaveBeenCalled()
    expect(screen.queryByText("Installation added successfully.")).toBeNull()
  })

  it("refuses, on macOS, a folder that differs from another Installation's only by case", async () => {
    const api = await addInstallationAt("/DATA/main", "darwin")
    expect(await screen.findByText("That folder is already in use.")).toBeTruthy()
    expect(api.pathsManager.ensurePathExists).not.toHaveBeenCalled()
  })

  describe("with the Installations and VS Versions folders set in Config first", () => {
    const alone = { installations: [], gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/elsewhere/1.20.0" }], backupsFolder: "/b" } as unknown as Partial<ConfigType>

    it.each([
      ["around both", "/data"],
      ["the Installations folder itself", "/data/Installations"],
      ["the VS Versions folder itself", "/data/Versions"]
    ])("refuses an Installation folder that is or holds %s", async (_name, picked) => {
      const api = await addInstallationAt(picked, "linux", alone)

      expect(await screen.findByText(NESTED)).toBeTruthy()
      expect(api.pathsManager.ensurePathExists).not.toHaveBeenCalled()
    })

    it("still adds a folder inside the Installations folder, the default layout", async () => {
      const api = await addInstallationAt("/data/Installations/Main2", "linux", alone)

      expect(await screen.findByText("Installation added successfully.")).toBeTruthy()
      expect(api.pathsManager.ensurePathExists).toHaveBeenCalledWith("/data/Installations/Main2")
    })
  })

  it("adds a folder beside the others", async () => {
    const api = await addInstallationAt("/data/Main2")

    expect(await screen.findByText("Installation added successfully.")).toBeTruthy()
    expect(api.pathsManager.ensurePathExists).toHaveBeenCalledWith("/data/Main2")
  })
})

describe("Config folder pickers", () => {
  const BROWSE = { installations: 0, versions: 1, backups: 2 }

  async function pick(picked: string, button: keyof typeof BROWSE, os: NodeJS.Platform = "linux"): Promise<void> {
    const user = userEvent.setup()
    mockApi(picked, os)

    renderWithProviders(
      <>
        <ConfigPage />
        <NotificationsOverlay />
      </>,
      { route: "/config" }
    )

    await waitFor(() => expect(screen.getByDisplayValue("/data/Backups")).toBeTruthy())
    await user.click(screen.getAllByTitle("Browse")[BROWSE[button]]!)
  }

  it.each(["installations", "versions", "backups"] as const)("refuses the %s folder inside an Installation and leaves the setting alone", async (button) => {
    await pick("/data/Main/Anywhere", button)

    expect(await screen.findByText(INSIDE)).toBeTruthy()
    expect(screen.getByDisplayValue("/data/Backups")).toBeTruthy()
    expect(screen.getByDisplayValue("/data/Installations")).toBeTruthy()
    expect(screen.getByDisplayValue("/data/Versions")).toBeTruthy()
  })

  it("refuses a Backups folder that holds an Installation", async () => {
    await pick("/data", "backups")

    expect(await screen.findByText(HOLDS)).toBeTruthy()
    expect(screen.getByDisplayValue("/data/Backups")).toBeTruthy()
  })

  it("keeps the Installations folder holding Installations, as it does by default", async () => {
    await pick("/data", "installations")

    await waitFor(() => expect(screen.getByDisplayValue("/data")).toBeTruthy())
    expect(screen.queryByText(HOLDS)).toBeNull()
    expect(screen.queryByText(INSIDE)).toBeNull()
  })

  it("reads case the way macOS does", async () => {
    await pick("/DATA/main/Backups", "backups", "darwin")
    expect(await screen.findByText(INSIDE)).toBeTruthy()
  })

  it("takes a Backups folder that touches no Installation", async () => {
    await pick("/picked/Backups", "backups")

    await waitFor(() => expect(screen.getByDisplayValue("/picked/Backups")).toBeTruthy())
  })
})
