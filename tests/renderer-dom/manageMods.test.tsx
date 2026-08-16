import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageMods from "@renderer/features/installations/pages/ManageMods"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi, type WindowApiOverrides } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const INSTALLATION_PATH = "/games/a"
const ALPHA_PATH = "/games/a/Mods/alpha-1.0.0.zip"
const BETA_PATH = "/games/a/Mods/beta-2.0.0.zip"

function anInstallation(): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: INSTALLATION_PATH,
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
    _modsCount: 0
  }
}

/** What the folder scan comes back with: two updatable Mods, one only-incompatible, one unreadable archive. */
function aModScan(): { mods: InstalledModType[]; errors: ErrorInstalledModType[] } {
  return {
    mods: [
      { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: ALPHA_PATH, description: "The first one.", authors: ["Ann"], contributors: [] },
      { name: "Beta Mod", modid: "beta", version: "2.0.0", path: BETA_PATH, description: "The second one.", authors: ["Bob"], contributors: [] },
      { name: "Gamma Mod", modid: "gamma", version: "3.0.0", path: "/games/a/Mods/gamma-3.0.0.zip", authors: ["Cal"], contributors: [] }
    ],
    errors: [{ zipname: "broken.zip", path: "/games/a/Mods/broken.zip" }]
  }
}

/**
 * One `/api/mod/{id}` payload. `tags` carry no leading "v" because that is what
 * evaluateModCompatibility matches against the Installation's game version.
 */
function aModDetail({ modid, assetid, name, modidstr, modversion, tags }: { modid: number; assetid: number; name: string; modidstr: string; modversion: string; tags: string[] }): string {
  return JSON.stringify({
    statuscode: "200",
    mod: {
      modid,
      assetid,
      name,
      releases: [
        {
          releaseid: modid,
          mainfile: `https://mods.example/${modidstr}-${modversion}.zip`,
          filename: `${modidstr}-${modversion}.zip`,
          fileid: modid,
          downloads: 0,
          tags,
          modidstr,
          modversion,
          created: "",
          changelog: ""
        }
      ]
    }
  })
}

function queryModDb(url: string): Promise<string> {
  if (url.endsWith("/mod/alpha")) return Promise.resolve(aModDetail({ modid: 1, assetid: 101, name: "Alpha Mod", modidstr: "alpha", modversion: "1.1.0", tags: ["1.20.0"] }))
  if (url.endsWith("/mod/beta")) return Promise.resolve(aModDetail({ modid: 2, assetid: 102, name: "Beta Mod", modidstr: "beta", modversion: "2.1.0", tags: ["1.20.0"] }))
  // Gamma's only newer release is tagged for another series, so it lands in the incompatible list.
  if (url.endsWith("/mod/gamma")) return Promise.resolve(aModDetail({ modid: 3, assetid: 103, name: "Gamma Mod", modidstr: "gamma", modversion: "3.1.0", tags: ["1.19.0"] }))
  return Promise.resolve(JSON.stringify({ statuscode: "404" }))
}

/**
 * ManageMods reads the Installation off the route and mounts before ConfigProvider's async
 * `getConfig()` resolves, exactly like a deep link or a slow disk would: the harness does not need
 * to gate mounting behind the Installations being in context, because the scan effect now re-runs
 * once the config's loaded state flips (#58).
 */
function renderManageMods(overrides: WindowApiOverrides = {}): void {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    modsManager: { getInstalledMods: vi.fn(async () => aModScan()) },
    netManager: { queryURL: vi.fn(queryModDb) },
    ...overrides
  })

  renderWithProviders(
    <Routes>
      <Route
        path="/installations/mods/:id"
        element={
          <TaskProvider>
            <ManageMods />
            <NotificationsOverlay />
          </TaskProvider>
        }
      />
    </Routes>,
    { route: "/installations/mods/install-a" }
  )
}

describe("ManageMods", () => {
  it("sorts the scanned Mods into the updatable, incompatible and unreadable lists", async () => {
    renderManageMods()

    expect(await screen.findByText("Alpha Mod", {}, { timeout: 3000 })).toBeTruthy()
    expect(screen.getByText("Beta Mod")).toBeTruthy()
    expect(screen.getByText("Gamma Mod")).toBeTruthy()

    expect(screen.getByText("Mods with updates")).toBeTruthy()
    expect(screen.getByText("Mods with incompatible updates")).toBeTruthy()

    // The unreadable archive is listed by its file name, under its own heading.
    expect(screen.getByText("Mods with errors")).toBeTruthy()
    expect(screen.getByText("broken.zip")).toBeTruthy()
  })

  it("leaves the Mod on disk until the delete confirm dialog is accepted", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn(async () => true)
    renderManageMods({ pathsManager: { deletePath } })

    const alphaItem = (await screen.findByText("Alpha Mod", {}, { timeout: 3000 })).closest("li")
    expect(alphaItem).toBeTruthy()

    await user.click(within(alphaItem as HTMLElement).getByTitle("Delete"))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Are you sure you want to delete this Mod?")).toBeTruthy()
    expect(deletePath).not.toHaveBeenCalled()

    await user.click(within(dialog).getByTitle("Delete"))

    await waitFor(() => expect(deletePath).toHaveBeenCalledWith(ALPHA_PATH))
    expect(await screen.findByText("Mod deleted successfully!")).toBeTruthy()
    await waitFor(() => expect(screen.queryByText("Are you sure you want to delete this Mod?")).toBeNull())
  })

  it("reports a half-failed bulk update as partial, not as a success", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    // Beta's download dies, Alpha's lands. One verdict has to cover both.
    const downloadOnPath = vi.fn(async (_id: string, url: string) => {
      if (url.includes("beta")) throw new Error("The transfer died.")
      return "/games/a/Mods/alpha-1.1.0.zip"
    })
    renderManageMods({ pathsManager: { deletePath, downloadOnPath } })

    await screen.findByText("Alpha Mod", {}, { timeout: 3000 })
    await screen.findByText("Beta Mod")

    // Found by its label, not its title: the open-Mods-folder button next to it reuses the very
    // same title string, so getByTitle matches two buttons.
    await user.click(screen.getByText("Update all").closest("button") as HTMLElement)

    expect(await screen.findByText("1 Mods updated, 1 left as they were. The summary says which ones.", {}, { timeout: 3000 })).toBeTruthy()
    expect(screen.queryByText("All the Mods were updated successfully!")).toBeNull()

    // Both attempts show up in the summary, the failed one without a target version.
    const summary = await screen.findByRole("dialog")
    expect(within(summary).getByText("Mod Update Summary")).toBeTruthy()
    expect(within(summary).getByText("v1.1.0")).toBeTruthy()
    expect(within(summary).getByText("Failed")).toBeTruthy()

    // Gamma had no compatible update, so the bulk run never touched it.
    expect(downloadOnPath).toHaveBeenCalledTimes(2)
    expect(deletePath.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([ALPHA_PATH, BETA_PATH]))
  })
})
