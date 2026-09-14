import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageMods from "@renderer/features/installations/pages/ManageMods"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi, type WindowApiOverrides } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const ALPHA_PATH = "/games/a/Mods/alpha-1.0.0.zip"
const BETA_PATH = "/games/a/Mods/beta-2.0.0.zip"
const GAMMA_PATH = "/games/a/Mods/gamma-3.0.0.zip"
const DELTA_PATH = "/games/a/Mods/delta-1.0.0.zip"
const DELTA_COPY_PATH = "/games/a/Mods/delta-1.0.1.zip"
const ZETA_PATH = "/games/a/Mods/zeta-1.0.0.zip"
const EPSILON_PATH = "/games/a/Mods/epsilon-1.0.0.zip.disabled"

function anInstallation(): InstallationType {
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
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    _modsCount: 0
  }
}

/**
 * A folder carrying one of everything the check reports: a dependency nothing in the folder
 * declares, one installed below the floor it asks for, one that is there but turned off, two
 * archives declaring one mod id, a Mod nobody has tagged for this game version, two Mods with a
 * newer release, and one archive the scan could not read at all.
 */
function anUnhealthyScan(): { mods: InstalledModType[]; errors: ErrorInstalledModType[] } {
  return {
    mods: [
      { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: ALPHA_PATH, enabled: true, authors: [], dependencies: { nowheremod: "1.0.0", game: "1.12.14" } },
      { name: "Beta Mod", modid: "beta", version: "2.0.0", path: BETA_PATH, enabled: true, authors: [], dependencies: { gamma: "4.0.0" } },
      { name: "Gamma Mod", modid: "gamma", version: "3.0.0", path: GAMMA_PATH, enabled: true, authors: [] },
      { name: "Delta Mod", modid: "delta", version: "1.0.0", path: DELTA_PATH, enabled: true, authors: [] },
      { name: "Delta Mod", modid: "delta", version: "1.0.1", path: DELTA_COPY_PATH, enabled: true, authors: [] },
      { name: "Zeta Mod", modid: "zeta", version: "1.0.0", path: ZETA_PATH, enabled: true, authors: [], dependencies: { epsilon: "1.0.0" } },
      { name: "Epsilon Mod", modid: "epsilon", version: "1.0.0", path: EPSILON_PATH, enabled: false, authors: [] }
    ],
    errors: [{ zipname: "broken.zip", path: "/games/a/Mods/broken.zip" }]
  }
}

/** One `/api/mod/{id}` payload, releases newest first, tags carrying no leading "v". */
function aModDetail(modid: number, name: string, modidstr: string, releases: { modversion: string; tags: string[] }[]): string {
  return JSON.stringify({
    statuscode: "200",
    mod: {
      modid,
      assetid: modid + 100,
      name,
      releases: releases.map((release, index) => ({
        releaseid: modid * 10 + index,
        mainfile: `https://mods.example/${modidstr}-${release.modversion}.zip`,
        filename: `${modidstr}-${release.modversion}.zip`,
        fileid: modid * 10 + index,
        downloads: 0,
        tags: release.tags,
        modidstr,
        modversion: release.modversion,
        created: "",
        changelog: ""
      }))
    }
  })
}

/** Alpha and Beta have a newer release for this series, Gamma is on one nobody tagged, the rest are unknown. */
function queryModDb(url: string): Promise<string> {
  if (url.endsWith("/mod/alpha"))
    return Promise.resolve(
      aModDetail(1, "Alpha Mod", "alpha", [
        { modversion: "1.1.0", tags: ["1.20.0"] },
        { modversion: "1.0.0", tags: ["1.20.0"] }
      ])
    )
  if (url.endsWith("/mod/beta"))
    return Promise.resolve(
      aModDetail(2, "Beta Mod", "beta", [
        { modversion: "2.1.0", tags: ["1.20.0"] },
        { modversion: "2.0.0", tags: ["1.20.0"] }
      ])
    )
  if (url.endsWith("/mod/gamma")) return Promise.resolve(aModDetail(3, "Gamma Mod", "gamma", [{ modversion: "3.0.0", tags: ["1.18.0"] }]))
  return Promise.resolve(JSON.stringify({ statuscode: "404" }))
}

function renderManageMods(overrides: WindowApiOverrides = {}): void {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    netManager: { queryURL: vi.fn(queryModDb) },
    ...overrides,
    modsManager: { getInstalledMods: vi.fn(async () => anUnhealthyScan()), ...overrides.modsManager }
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

/** The panel's body, reached the way a screen reader reaches it: through the toggle's aria-controls. */
async function healthBody(): Promise<HTMLElement> {
  const toggle = await screen.findByRole("button", { name: "Installation check" }, { timeout: 3000 })
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  return document.getElementById(toggle.getAttribute("aria-controls") ?? "") as HTMLElement
}

/** One finding's line, by the sentence it reads as. */
async function lineSaying(text: RegExp): Promise<HTMLElement> {
  return (await screen.findByText(text, {}, { timeout: 3000 })).closest("li") as HTMLElement
}

describe("ManageMods: the Installation check", () => {
  it("lists the four kinds of finding, worst first, and says what it could not check", async () => {
    renderManageMods()
    const body = await healthBody()

    await waitFor(() => expect(within(body).getAllByRole("heading", { level: 3 }).length).toBe(4), { timeout: 3000 })
    expect(
      within(body)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["Will not load", "Duplicates", "Not declared for this Vintage Story version", "Update available"])

    // Blocking, in mod id order, and each sentence says which of the three shapes of failure it is.
    expect(within(body).getByText("Alpha Mod needs nowheremod 1.0.0 or newer, which is not in this folder.")).toBeTruthy()
    expect(within(body).getByText("Beta Mod needs gamma 4.0.0 or newer, and 3.0.0 is installed.")).toBeTruthy()
    expect(within(body).getByText("Zeta Mod needs epsilon, which is installed but turned off.")).toBeTruthy()

    // Both copies of one mod id get a line, each naming the other by the file name that tells them apart.
    expect(within(body).getByText("Delta Mod (delta-1.0.0.zip) declares the same mod id as Delta Mod (delta-1.0.1.zip). Vintage Story loads one of the two.")).toBeTruthy()
    expect(within(body).getByText("Delta Mod (delta-1.0.1.zip) declares the same mod id as Delta Mod (delta-1.0.0.zip). Vintage Story loads one of the two.")).toBeTruthy()

    expect(within(body).getByText("Nobody has said Gamma Mod works on 1.20.0. It may still run.")).toBeTruthy()
    expect(within(body).getByText("Alpha Mod has a newer release for this version: 1.1.0.")).toBeTruthy()

    // The two footnotes: what the ModDB never answered for, and the archive that was never read.
    expect(within(body).getByText("3 Mods could not be checked against the ModDB.")).toBeTruthy()
    expect(within(body).getByText("1 archive could not be read, so it was left out of this check.")).toBeTruthy()
  })

  it("says the Installation's game version is too old rather than offering to install the game", async () => {
    const scan = anUnhealthyScan()
    scan.mods[0] = { ...(scan.mods[0] as InstalledModType), dependencies: { game: "1.21.0" } }
    renderManageMods({ modsManager: { getInstalledMods: vi.fn(async () => scan) } })
    const body = await healthBody()

    expect(await within(body).findByText("Alpha Mod asks for Vintage Story 1.21.0 or newer, and this Installation runs 1.20.0.", {}, { timeout: 3000 })).toBeTruthy()
    // A bundled mod id is a floor against the game, so there is nothing here offering to install it.
    expect(within(body).queryByRole("button", { name: "Install game" })).toBeNull()
  })

  it("still names the missing dependencies and the duplicates with no ModDB answer at all", async () => {
    renderManageMods({ netManager: { queryURL: vi.fn(async () => JSON.stringify({ statuscode: "404" })) } })
    const body = await healthBody()

    expect(await within(body).findByText("Alpha Mod needs nowheremod 1.0.0 or newer, which is not in this folder.", {}, { timeout: 3000 })).toBeTruthy()
    expect(within(body).getByText("Delta Mod (delta-1.0.0.zip) declares the same mod id as Delta Mod (delta-1.0.1.zip). Vintage Story loads one of the two.")).toBeTruthy()

    // Six enabled copies, none of them answered for, and neither ModDB verdict is claimed for any.
    expect(within(body).getByText("6 Mods could not be checked against the ModDB.")).toBeTruthy()
    expect(within(body).queryByRole("heading", { level: 3, name: "Update available" })).toBeNull()
    expect(within(body).queryByRole("heading", { level: 3, name: "Not declared for this Vintage Story version" })).toBeNull()
  })

  it("opens the install popup on the dependency nobody has installed yet", async () => {
    const user = userEvent.setup()
    renderManageMods()

    const line = await lineSaying(/Alpha Mod needs nowheremod/)
    await user.click(within(line).getByRole("button", { name: "Install nowheremod" }))

    const popup = await screen.findByRole("dialog")
    expect(within(popup).getByText("List of versions of the nowheremod Mod")).toBeTruthy()
  })

  it("turns a dependency that is only turned off back on, through the action the row already uses", async () => {
    const user = userEvent.setup()
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async () => ({ ok: true, path: "/games/a/Mods/epsilon-1.0.0.zip" }))
    renderManageMods({ modsManager: { setModEnabled } })

    const line = await lineSaying(/Zeta Mod needs epsilon/)
    await user.click(within(line).getByRole("button", { name: "Turn it back on" }))

    await waitFor(() => expect(setModEnabled).toHaveBeenCalledWith(EPSILON_PATH, true))
  })

  it("deletes the copy the duplicate line is about, never the other one, and only once confirmed", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    renderManageMods({ pathsManager: { deletePath } })

    const line = await lineSaying(/Delta Mod \(delta-1\.0\.1\.zip\) declares the same mod id/)
    await user.click(within(line).getByRole("button", { name: "Delete" }))

    const dialog = await screen.findByRole("dialog")
    expect(deletePath).not.toHaveBeenCalled()
    await user.click(within(dialog).getByTitle("Delete"))

    await waitFor(() => expect(deletePath).toHaveBeenCalledWith(DELTA_COPY_PATH))
    expect(deletePath).toHaveBeenCalledTimes(1)
  })

  it("drops every line about a Mod the player holds", async () => {
    const user = userEvent.setup()
    renderManageMods()

    const line = await lineSaying(/Alpha Mod needs nowheremod/)
    await user.click(within(line).getByRole("button", { name: "Hold" }))

    await waitFor(() => expect(screen.queryByText(/Alpha Mod needs nowheremod/)).toBeNull())
    // Held for good, in both sections: the update line is about the same Mod.
    expect(screen.queryByText("Alpha Mod has a newer release for this version: 1.1.0.")).toBeNull()
    // Everybody else's findings stay exactly as they were.
    expect(screen.getByText("Beta Mod needs gamma 4.0.0 or newer, and 3.0.0 is installed.")).toBeTruthy()
  })

  it("reports a half-failed Update these per Mod and leaves the one that went through alone", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const downloadOnPath = vi.fn(async (_id: string, url: string) => {
      if (url.includes("beta")) throw new Error("The transfer died.")
      return "/games/a/Mods/alpha-1.1.0.zip"
    })
    renderManageMods({ pathsManager: { deletePath, downloadOnPath } })

    const body = await healthBody()
    await within(body).findByText("Beta Mod has a newer release for this version: 2.1.0.", {}, { timeout: 3000 })

    await user.click(within(body).getByRole("button", { name: "Update these" }))

    expect(await screen.findByText("1 Mods updated, 1 left as they were. The summary says which ones.", {}, { timeout: 3000 })).toBeTruthy()

    // Both attempts are in the summary, the failed one with no target version, and Alpha's new
    // archive is not rolled back over one Mod that did not make it.
    const summary = await screen.findByRole("dialog")
    expect(within(summary).getByText("v1.1.0")).toBeTruthy()
    expect(within(summary).getByText("Failed")).toBeTruthy()
    expect(deletePath.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([ALPHA_PATH, BETA_PATH]))
    // Nothing rolls Alpha back over a Mod that did not make it: its new archive is left where it landed.
    expect(deletePath.mock.calls.map((call) => call[0])).not.toContain("/games/a/Mods/alpha-1.1.0.zip")
  })

  it("stays collapsed and says the folder is clean when there is nothing to fix", async () => {
    const user = userEvent.setup()
    renderManageMods({
      modsManager: {
        getInstalledMods: vi.fn(async () => ({
          mods: [{ name: "Alpha Mod", modid: "alpha", version: "1.1.0", path: ALPHA_PATH, enabled: true, authors: [], dependencies: { game: "1.12.14" } }],
          errors: [{ zipname: "broken.zip", path: "/games/a/Mods/broken.zip" }]
        }))
      }
    })

    const toggle = await screen.findByRole("button", { name: "Installation check" }, { timeout: 3000 })
    await waitFor(() => expect(screen.getByText("Nothing to fix.")).toBeTruthy(), { timeout: 3000 })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")

    // Nothing to fix still leaves the unreadable archive to say, which is what opening it shows.
    await user.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("1 archive could not be read, so it was left out of this check.")).toBeTruthy()
  })
})
