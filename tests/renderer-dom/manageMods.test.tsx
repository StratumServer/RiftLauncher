import { describe, expect, it, vi } from "vitest"
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
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
const DELTA_PATH = "/games/a/Mods/delta-4.0.0.zip"
const SEARCH_PLACEHOLDER = "Search by name or id"
const SUSPEND_TITLE = "Suspend updates for this Mod: Update all will skip it, you can still update it from here"
const RESUME_TITLE = "Resume updates for this Mod: Update all will include it again"
const EPSILON_PATH = "/games/a/Mods/epsilon-5.0.0.zip.disabled"
const ALPHA_LOGO = "https://moddbcdn.vintagestory.at/alpha.png"
const BETA_LOGO = "https://moddbcdn.vintagestory.at/beta.png"
const DISABLE_TITLE = "Disable this Mod: it stays installed, Vintage Story just won't load it"
const ENABLE_TITLE = "Enable this Mod: Vintage Story will load it again"

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

/** What the folder scan comes back with: two updatable Mods, one only-incompatible, one up to date, one unreadable archive. */
function aModScan(): { mods: InstalledModType[]; errors: ErrorInstalledModType[] } {
  return {
    mods: [
      { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: ALPHA_PATH, enabled: true, description: "The first one.", authors: ["Ann"], contributors: [], _image: "alpha.png" },
      { name: "Beta Mod", modid: "beta", version: "2.0.0", path: BETA_PATH, enabled: true, description: "The second one.", side: "Server", authors: ["Bob"], contributors: [] },
      // No declared side at all, which the server export reads as "the server loads it".
      { name: "Gamma Mod", modid: "gamma", version: "3.0.0", path: "/games/a/Mods/gamma-3.0.0.zip", enabled: true, authors: ["Cal"], contributors: [] },
      // Its id shares nothing with its name, so a search hitting it can only have matched the id.
      { name: "Delta Mod", modid: "quirkid", version: "4.0.0", path: DELTA_PATH, enabled: true, side: "Client", authors: ["Dee"], contributors: [] }
    ],
    errors: [{ zipname: "broken.zip", path: "/games/a/Mods/broken.zip" }]
  }
}

/**
 * A folder holding one Mod the player turned off (#287). Epsilon is updatable and a server would
 * load it, so one fixture answers what Update all does, what an export ships and what a row shows.
 */
function scanWithADisabledMod(): { mods: InstalledModType[]; errors: ErrorInstalledModType[] } {
  return {
    mods: [
      { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: ALPHA_PATH, enabled: true, authors: ["Ann"], contributors: [] },
      { name: "Epsilon Mod", modid: "epsilon", version: "5.0.0", path: EPSILON_PATH, enabled: false, authors: ["Eve"], contributors: [] }
    ],
    errors: []
  }
}

function duplicateModScan(): { mods: InstalledModType[]; errors: ErrorInstalledModType[] } {
  return {
    mods: [
      { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: ALPHA_PATH, enabled: true, authors: [] },
      { name: "Alpha Mod copy", modid: "alpha", version: "1.0.1", path: "/games/a/Mods/alpha-copy-1.0.1.zip", enabled: true, authors: [] }
    ],
    errors: []
  }
}

/**
 * One `/api/mod/{id}` payload. `tags` carry no leading "v" because that is what
 * evaluateModCompatibility matches against the Installation's game version.
 */
function aModDetail({
  modid,
  assetid,
  name,
  modidstr,
  modversion,
  tags,
  logofile
}: {
  modid: number
  assetid: number
  name: string
  modidstr: string
  modversion: string
  tags: string[]
  logofile?: string
}): string {
  return JSON.stringify({
    statuscode: "200",
    mod: {
      modid,
      assetid,
      name,
      ...(logofile ? { logofile } : {}),
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
  // Alpha carries a logofile AND every scan fixture gives it a local _image, so the guard in
  // useGetCompleteInstalledMods is the only thing keeping the network out of Alpha's row.
  if (url.endsWith("/mod/alpha")) return Promise.resolve(aModDetail({ modid: 1, assetid: 101, name: "Alpha Mod", modidstr: "alpha", modversion: "1.1.0", tags: ["1.20.0"], logofile: ALPHA_LOGO }))
  if (url.endsWith("/mod/beta")) return Promise.resolve(aModDetail({ modid: 2, assetid: 102, name: "Beta Mod", modidstr: "beta", modversion: "2.1.0", tags: ["1.20.0"], logofile: BETA_LOGO }))
  // Gamma's only newer release is tagged for another series, so it lands in the incompatible list.
  if (url.endsWith("/mod/gamma")) return Promise.resolve(aModDetail({ modid: 3, assetid: 103, name: "Gamma Mod", modidstr: "gamma", modversion: "3.1.0", tags: ["1.19.0"] }))
  if (url.endsWith("/mod/epsilon")) return Promise.resolve(aModDetail({ modid: 5, assetid: 105, name: "Epsilon Mod", modidstr: "epsilon", modversion: "5.1.0", tags: ["1.20.0"] }))
  return Promise.resolve(JSON.stringify({ statuscode: "404" }))
}

/**
 * ManageMods reads the Installation off the route and mounts before ConfigProvider's async
 * `getConfig()` resolves, exactly like a deep link or a slow disk would: the harness does not need
 * to gate mounting behind the Installations being in context, because the scan effect now re-runs
 * once the config's loaded state flips (#58).
 */
function renderManageMods(overrides: WindowApiOverrides = {}): ReturnType<typeof renderWithProviders> {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    netManager: { queryURL: vi.fn(queryModDb) },
    ...overrides,
    // Last, and merged rather than replaced: a test overriding one modsManager call still wants the
    // folder scan the rest of this file is written against.
    modsManager: { getInstalledMods: vi.fn(async () => aModScan()), ...overrides.modsManager }
  })

  return renderWithProviders(
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

    // Alpha is the only fixture with a cached icon, so its <img> is the one path that exercises
    // the loading="lazy" branch instead of the placeholder <div>.
    const alphaImage = screen.getByAltText("Alpha Mod")
    expect(alphaImage.getAttribute("src")).toBe("cachemodimg:alpha.png")
    expect(alphaImage.getAttribute("loading")).toBe("lazy")

    expect(screen.getByText("Mods with updates")).toBeTruthy()
    expect(screen.getByText("Mods with incompatible updates")).toBeTruthy()

    // The unreadable archive is listed by its file name, under its own heading.
    expect(screen.getByText("Mods with errors")).toBeTruthy()
    expect(screen.getByText("broken.zip")).toBeTruthy()

    // A list this long (the installed-mods folder, not the ModDB grid) can also run into the
    // hundreds, so each row skips layout/paint once scrolled out of view the same way
    // ModListCard's own content already does.
    const alphaRow = screen.getByText("Alpha Mod").closest("li")?.firstElementChild
    expect(alphaRow?.className).toContain("skip-offscreen-render")
  })

  it("queries one ModDB detail for repeated installed mod ids", async () => {
    const queryURL = vi.fn(queryModDb)
    renderManageMods({
      netManager: { queryURL },
      modsManager: { getInstalledMods: vi.fn(async () => duplicateModScan()) }
    })

    expect(await screen.findByText("Alpha Mod", {}, { timeout: 3000 })).toBeTruthy()
    expect(await screen.findByText("Alpha Mod copy", {}, { timeout: 3000 })).toBeTruthy()
    await waitFor(() => expect(queryURL.mock.calls.filter(([url]) => url.endsWith("/mod/alpha"))).toHaveLength(1))
  })

  it("prefers the archive's own icon and only reaches for the ModDB logo without one", async () => {
    const cacheModImage = vi.fn(async (url: string) => (url === BETA_LOGO ? "beta-logo.png" : "unexpected.png"))
    renderManageMods({ modsManager: { cacheModImage } })

    expect(await screen.findByText("Beta Mod", {}, { timeout: 3000 })).toBeTruthy()
    await waitFor(() => expect(cacheModImage).toHaveBeenCalledWith(BETA_LOGO))

    // Beta ships no modicon.png, so its row falls back to the ModDB logo.
    expect(screen.getByAltText("Beta Mod").getAttribute("src")).toBe("cachemodimg:beta-logo.png")
    // Alpha ships its own modicon.png and its ModDB entry has a logo too, so the guard is the only
    // thing keeping the network out of it and the row on its local file.
    expect(cacheModImage).not.toHaveBeenCalledWith(ALPHA_LOGO)
    expect(screen.getByAltText("Alpha Mod").getAttribute("src")).toBe("cachemodimg:alpha.png")
  })

  it("caches one ModDB logo for repeated installed mod ids", async () => {
    const cacheModImage = vi.fn(async (url: string) => (url === ALPHA_LOGO ? "alpha-logo.png" : "unexpected.png"))
    renderManageMods({ modsManager: { getInstalledMods: vi.fn(async () => duplicateModScan()), cacheModImage } })

    expect(await screen.findByText("Alpha Mod copy", {}, { timeout: 3000 })).toBeTruthy()
    await waitFor(() => expect(cacheModImage.mock.calls.filter(([url]) => url === ALPHA_LOGO)).toHaveLength(1))
    expect(screen.getAllByAltText(/Alpha Mod/).map((img) => img.getAttribute("src"))).toEqual(["cachemodimg:alpha-logo.png", "cachemodimg:alpha-logo.png"])
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

/** Issue #194: a Mod the player holds at its current version, without going blind to what is out there. */
describe("ManageMods: suspended Mod updates", () => {
  /** The row for one Mod, found by its name. */
  async function rowFor(name: string): Promise<HTMLElement> {
    return (await screen.findByText(name, {}, { timeout: 3000 })).closest("li") as HTMLElement
  }

  it("toggles the suspension from the row, and says which state the row is in", async () => {
    const user = userEvent.setup()
    renderManageMods()

    const alphaRow = await rowFor("Alpha Mod")
    expect(within(alphaRow).getByTitle(SUSPEND_TITLE)).toBeTruthy()

    await user.click(within(alphaRow).getByTitle(SUSPEND_TITLE))

    expect(within(alphaRow).getByTitle(RESUME_TITLE)).toBeTruthy()
    // Marked at a glance, in the same tint family the row already uses for its update states.
    expect(alphaRow.firstElementChild?.className).toContain("bg-sky-500/25")

    await user.click(within(alphaRow).getByTitle(RESUME_TITLE))

    expect(within(alphaRow).getByTitle(SUSPEND_TITLE)).toBeTruthy()
    expect(alphaRow.firstElementChild?.className).not.toContain("bg-sky-500/25")
  })

  it("leaves a suspended Mod out of Update all and updates the rest", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const downloadOnPath = vi.fn(async (_id: string, url: string) => (url.includes("alpha") ? "/games/a/Mods/alpha-1.1.0.zip" : "/games/a/Mods/beta-2.1.0.zip"))
    renderManageMods({ pathsManager: { deletePath, downloadOnPath } })

    const alphaRow = await rowFor("Alpha Mod")
    await screen.findByText("Beta Mod")

    await user.click(within(alphaRow).getByTitle(SUSPEND_TITLE))
    await user.click(screen.getByText("Update all").closest("button") as HTMLElement)

    expect(await screen.findByText("All the Mods were updated successfully!", {}, { timeout: 3000 })).toBeTruthy()

    // Beta was updated, Alpha was not touched at all.
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
    expect(downloadOnPath.mock.calls[0]?.[1]).toContain("beta")
    expect(deletePath.mock.calls.map((call) => call[0])).toEqual([BETA_PATH])
  })

  it("still lists a suspended Mod under the Mods with updates heading", async () => {
    const user = userEvent.setup()
    renderManageMods()

    const alphaRow = await rowFor("Alpha Mod")
    await user.click(within(alphaRow).getByTitle(SUSPEND_TITLE))

    // Watching for the new version is the reason to suspend, so the notice has to survive it.
    const updatesSection = screen.getByText("Mods with updates").closest("ul") as HTMLElement
    expect(within(updatesSection).getByText("Alpha Mod")).toBeTruthy()
  })

  it("updates a suspended Mod from its own row and keeps it suspended afterwards", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const downloadOnPath = vi.fn(async () => "/games/a/Mods/alpha-1.1.0.zip")
    renderManageMods({ pathsManager: { deletePath, downloadOnPath } })

    const alphaRow = await rowFor("Alpha Mod")
    await user.click(within(alphaRow).getByTitle(SUSPEND_TITLE))

    await user.click(within(alphaRow).getByTitle("Update"))

    const popup = await screen.findByRole("dialog")
    await user.click(within(popup).getByTitle("Author tagged it as compatible with your selected Vintage Story Version!"))

    await waitFor(() => expect(downloadOnPath).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(deletePath).toHaveBeenCalledWith(ALPHA_PATH))

    // The suspension is lifted by the player, never by an update they asked for themselves.
    expect(within(await rowFor("Alpha Mod")).getByTitle(RESUME_TITLE)).toBeTruthy()
  })
})

/** Issue #228: finding one Mod in a long installed list, without knowing which section it landed in. */
describe("ManageMods: searching the installed Mods", () => {
  /** Waits for the scan to land, then types into the search field. */
  async function searchFor(user: ReturnType<typeof userEvent.setup>, text: string): Promise<HTMLElement> {
    await screen.findByText("Alpha Mod", {}, { timeout: 3000 })
    const field = screen.getByPlaceholderText(SEARCH_PLACEHOLDER)
    await user.type(field, text)
    return field
  }

  it("narrows every section at once and leaves the emptied ones out", async () => {
    const user = userEvent.setup()
    renderManageMods()

    // "ta" is in Beta (updatable) and Delta (up to date), in neither Gamma nor the unreadable archive.
    await searchFor(user, "ta")

    await waitFor(() => expect(screen.queryByText("Alpha Mod")).toBeNull())
    expect(screen.getByText("Beta Mod")).toBeTruthy()
    expect(screen.getByText("Delta Mod")).toBeTruthy()
    expect(screen.queryByText("Gamma Mod")).toBeNull()
    expect(screen.queryByText("broken.zip")).toBeNull()

    // No heading is left standing over a section the search emptied.
    expect(screen.queryByText("Mods with incompatible updates")).toBeNull()
    expect(screen.queryByText("Mods with errors")).toBeNull()
    expect(screen.getByText("Mods with updates")).toBeTruthy()

    // What the sections add up to is what the player can see, one row each.
    const updatesSection = screen.getByText("Mods with updates").closest("ul") as HTMLElement
    expect(within(updatesSection).getAllByRole("listitem")).toHaveLength(1)
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
  })

  it("finds a Mod by its id, not only by its name", async () => {
    const user = userEvent.setup()
    renderManageMods()

    await searchFor(user, "quirk")

    // Delta's name has no "quirk" in it, so only its modid can have matched.
    expect(await screen.findByText("Delta Mod")).toBeTruthy()
    await waitFor(() => expect(screen.queryByText("Alpha Mod")).toBeNull())
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
  })

  it("ignores case, on the name and on the id alike", async () => {
    const user = userEvent.setup()
    renderManageMods()

    await searchFor(user, "BETA")

    expect(await screen.findByText("Beta Mod")).toBeTruthy()
    await waitFor(() => expect(screen.queryByText("Gamma Mod")).toBeNull())

    await user.clear(screen.getByPlaceholderText(SEARCH_PLACEHOLDER))
    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "QUIRKID")

    expect(await screen.findByText("Delta Mod")).toBeTruthy()
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
  })

  it("says so when nothing matches, instead of showing empty sections", async () => {
    const user = userEvent.setup()
    renderManageMods()

    await searchFor(user, "nothinglikethis")

    expect(await screen.findByText("There are no Mods that match your filters!")).toBeTruthy()
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.queryByText("Mods with updates")).toBeNull()
  })

  it("puts the whole list back when the field is cleared", async () => {
    const user = userEvent.setup()
    renderManageMods()

    const field = await searchFor(user, "ta")
    await waitFor(() => expect(screen.queryByText("Gamma Mod")).toBeNull())

    await user.clear(field)

    expect(await screen.findByText("Gamma Mod")).toBeTruthy()
    expect(screen.getByText("Alpha Mod")).toBeTruthy()
    expect(screen.getByText("Mods with incompatible updates")).toBeTruthy()
    expect(screen.getByText("broken.zip")).toBeTruthy()
    expect(screen.getAllByRole("listitem")).toHaveLength(5)
  })

  it("updates only the Mods the search left on screen", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const downloadOnPath = vi.fn(async (_id: string, url: string) => (url.includes("alpha") ? "/games/a/Mods/alpha-1.1.0.zip" : "/games/a/Mods/beta-2.1.0.zip"))
    renderManageMods({ pathsManager: { deletePath, downloadOnPath } })

    await searchFor(user, "alpha")
    await waitFor(() => expect(screen.queryByText("Beta Mod")).toBeNull())

    await user.click(screen.getByText("Update all").closest("button") as HTMLElement)

    expect(await screen.findByText("All the Mods were updated successfully!", {}, { timeout: 3000 })).toBeTruthy()

    // Beta is updatable too, but it is not what the player is looking at.
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
    expect(downloadOnPath.mock.calls[0]?.[1]).toContain("alpha")
    expect(deletePath.mock.calls.map((call) => call[0])).toEqual([ALPHA_PATH])
  })

  it("greys the server export out when the search leaves only a client Mod", async () => {
    const user = userEvent.setup()
    const exportModpack = vi.fn<BridgeAPI["modsManager"]["exportModpack"]>(async () => ({ success: true }))
    renderManageMods({ modsManager: { exportModpack } })

    // Delta is the only client-only Mod, and its id is the only thing "quirk" can match.
    await searchFor(user, "quirk")
    await waitFor(() => expect(screen.queryByText("Alpha Mod")).toBeNull())

    // Nothing on screen would go into a server modpack, so there is nothing to export.
    expect((screen.getByText("Export Server Modpack").closest("button") as HTMLButtonElement).disabled).toBe(true)

    // The plain export ships the visible list itself, so one visible Mod is still one Mod to write.
    const plainExport = screen.getByText("Export Modpack").closest("button") as HTMLButtonElement
    expect(plainExport.disabled).toBe(false)

    await user.click(plainExport)

    await waitFor(() => expect(exportModpack).toHaveBeenCalledTimes(1))
    expect(exportModpack.mock.calls[0]?.[0].mods).toEqual([{ modid: "quirkid", version: "4.0.0" }])
  })

  it("writes the server modpack from the same visible list that decides the button", async () => {
    const user = userEvent.setup()
    const exportModpack = vi.fn<BridgeAPI["modsManager"]["exportModpack"]>(async () => ({ success: true }))
    renderManageMods({ modsManager: { exportModpack } })

    // "ta" leaves Beta, which a server loads, next to Delta, which it does not.
    await searchFor(user, "ta")
    await waitFor(() => expect(screen.queryByText("Alpha Mod")).toBeNull())

    const serverExport = screen.getByText("Export Server Modpack").closest("button") as HTMLButtonElement
    expect(serverExport.disabled).toBe(false)

    await user.click(serverExport)

    await waitFor(() => expect(exportModpack).toHaveBeenCalledTimes(1))
    const manifest = exportModpack.mock.calls[0]?.[0] as ModpackManifestType
    expect(manifest.name).toBe("Install A (Server)")
    // Beta and nothing else: not Delta, which is on screen but client-only, and not Alpha or Gamma,
    // which a server would load but the search took away.
    expect(manifest.mods).toEqual([{ modid: "beta", version: "2.0.0" }])
  })
})

/** Issue #287: turning a Mod off without uninstalling it, and what the rest of the page does about it. */
describe("ManageMods: enabling and disabling a Mod", () => {
  async function rowFor(name: string): Promise<HTMLElement> {
    return (await screen.findByText(name, {}, { timeout: 3000 })).closest("li") as HTMLElement
  }

  /** The page with the disabled-Mod folder, plus whatever the case needs on top. */
  function renderWithADisabledMod(overrides: WindowApiOverrides = {}): ReturnType<typeof renderManageMods> {
    return renderManageMods({ ...overrides, modsManager: { getInstalledMods: vi.fn(async () => scanWithADisabledMod()), ...overrides.modsManager } })
  }

  it("greys a disabled Mod, says so on the row, and offers to turn it back on", async () => {
    renderWithADisabledMod()

    const epsilonRow = await rowFor("Epsilon Mod")

    expect(within(epsilonRow).getByText("Disabled")).toBeTruthy()
    expect(within(epsilonRow).getByTitle(ENABLE_TITLE)).toBeTruthy()
    expect(epsilonRow.firstElementChild?.className).toContain("bg-zinc-500/25")

    // An enabled row offers the other direction and is not greyed at all.
    const alphaRow = await rowFor("Alpha Mod")
    expect(within(alphaRow).getByTitle(DISABLE_TITLE)).toBeTruthy()
    expect(within(alphaRow).queryByText("Disabled")).toBeNull()
    expect(alphaRow.firstElementChild?.className).not.toContain("bg-zinc-500/25")
  })

  it("asks the host to rename the archive, then rescans the folder", async () => {
    const user = userEvent.setup()
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string) => ({ ok: true, path }))
    const getInstalledMods = vi.fn(async () => scanWithADisabledMod())
    renderWithADisabledMod({ modsManager: { setModEnabled, getInstalledMods } })

    const alphaRow = await rowFor("Alpha Mod")
    const scansBefore = getInstalledMods.mock.calls.length

    await user.click(within(alphaRow).getByTitle(DISABLE_TITLE))

    // The renderer names the file and the state it wants. It never composes the new name.
    await waitFor(() => expect(setModEnabled).toHaveBeenCalledWith(ALPHA_PATH, false))
    expect(await screen.findByText("Alpha Mod is disabled and will not be loaded!")).toBeTruthy()
    // The archive's name is its path, so every button on that row is pointing at a name that has
    // just stopped existing. The rescan is what puts them back on the real file.
    await waitFor(() => expect(getInstalledMods.mock.calls.length).toBeGreaterThan(scansBefore))
  })

  it("sends one rename when the same row is clicked twice before the first one lands", async () => {
    let landIpc: (result: SetModEnabledResult) => void = () => {}
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(() => new Promise<SetModEnabledResult>((resolve) => (landIpc = resolve)))
    const getInstalledMods = vi.fn(async () => scanWithADisabledMod())
    renderWithADisabledMod({ modsManager: { setModEnabled, getInstalledMods } })

    const alphaRow = await rowFor("Alpha Mod")
    const disableButton = within(alphaRow).getByTitle(DISABLE_TITLE) as HTMLButtonElement
    const scansBefore = getInstalledMods.mock.calls.length

    // Both clicks inside one commit, which is what an impatient double click actually looks like:
    // the second one arrives before React has painted anything the first one changed.
    await act(async () => {
      disableButton.click()
      disableButton.click()
    })

    // Only the first click reached the host, and it carried the only name that still exists. The
    // second would have sent the same one, and the answer to it would have been an error the player
    // reads next to a success for the one thing they asked for.
    expect(setModEnabled).toHaveBeenCalledTimes(1)
    expect(setModEnabled).toHaveBeenCalledWith(ALPHA_PATH, false)
    expect(disableButton.disabled).toBe(true)

    await act(async () => {
      landIpc({ ok: true, path: `${ALPHA_PATH}.disabled` })
    })

    expect(await screen.findByText("Alpha Mod is disabled and will not be loaded!")).toBeTruthy()
    expect(screen.queryByText("An error has occurred enabling or disabling Alpha Mod!")).toBeNull()
    await waitFor(() => expect(getInstalledMods.mock.calls.length).toBeGreaterThan(scansBefore))
    // Still one call once everything has settled, and the row is live again for the next real click.
    expect(setModEnabled).toHaveBeenCalledTimes(1)
    await waitFor(() => expect((within(alphaRow).getByTitle(DISABLE_TITLE) as HTMLButtonElement).disabled).toBe(false))
  })

  it("turns a disabled Mod back on from its own row", async () => {
    const user = userEvent.setup()
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string) => ({ ok: true, path }))
    renderWithADisabledMod({ modsManager: { setModEnabled } })

    await user.click(within(await rowFor("Epsilon Mod")).getByTitle(ENABLE_TITLE))

    await waitFor(() => expect(setModEnabled).toHaveBeenCalledWith(EPSILON_PATH, true))
    expect(await screen.findByText("Epsilon Mod is enabled again!")).toBeTruthy()
  })

  it("names the clash instead of pretending nothing happened when the other file already exists", async () => {
    const user = userEvent.setup()
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async () => ({ ok: false, reason: "name-taken" }))
    renderWithADisabledMod({ modsManager: { setModEnabled } })

    await user.click(within(await rowFor("Alpha Mod")).getByTitle(DISABLE_TITLE))

    expect(await screen.findByText(/There is already another file where Alpha Mod would have been renamed/)).toBeTruthy()
  })

  it("leaves a disabled Mod out of Update all and updates the rest", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const downloadOnPath = vi.fn(async (_id: string, url: string) => (url.includes("alpha") ? "/games/a/Mods/alpha-1.1.0.zip" : "/games/a/Mods/epsilon-5.1.0.zip"))
    renderWithADisabledMod({ pathsManager: { deletePath, downloadOnPath } })

    await rowFor("Alpha Mod")
    // Epsilon has an update waiting and is still listed under the heading that says so.
    const updatesSection = screen.getByText("Mods with updates").closest("ul") as HTMLElement
    expect(within(updatesSection).getByText("Epsilon Mod")).toBeTruthy()

    await user.click(screen.getByText("Update all").closest("button") as HTMLElement)

    expect(await screen.findByText("All the Mods were updated successfully!", {}, { timeout: 3000 })).toBeTruthy()
    // Alpha only. A Mod that is off does not silently change version.
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
    expect(downloadOnPath.mock.calls[0]?.[1]).toContain("alpha")
    expect(deletePath.mock.calls.map((call) => call[0])).toEqual([ALPHA_PATH])
  })

  it("keeps a disabled Mod out of both modpack exports, because an export is the playable set", async () => {
    const user = userEvent.setup()
    const exportModpack = vi.fn<BridgeAPI["modsManager"]["exportModpack"]>(async () => ({ success: true }))
    renderWithADisabledMod({ modsManager: { exportModpack } })

    await rowFor("Epsilon Mod")

    await user.click(screen.getByText("Export Modpack").closest("button") as HTMLElement)
    await waitFor(() => expect(exportModpack).toHaveBeenCalledTimes(1))
    expect(exportModpack.mock.calls[0]?.[0].mods).toEqual([{ modid: "alpha", version: "1.0.0" }])

    // Epsilon declares no side, which the server export otherwise reads as "the server loads it".
    await user.click(screen.getByText("Export Server Modpack").closest("button") as HTMLElement)
    await waitFor(() => expect(exportModpack).toHaveBeenCalledTimes(2))
    expect(exportModpack.mock.calls[1]?.[0].mods).toEqual([{ modid: "alpha", version: "1.0.0" }])
  })

  it("finds a disabled Mod by search like any other, name or id", async () => {
    const user = userEvent.setup()
    renderWithADisabledMod()

    await rowFor("Epsilon Mod")
    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "epsilon")

    expect(await screen.findByText("Epsilon Mod")).toBeTruthy()
    await waitFor(() => expect(screen.queryByText("Alpha Mod")).toBeNull())
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
  })

  it("deletes a disabled Mod by the file name it actually has", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn(async () => true)
    renderWithADisabledMod({ pathsManager: { deletePath } })

    await user.click(within(await rowFor("Epsilon Mod")).getByTitle("Delete"))

    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByTitle("Delete"))

    // The `.disabled` name is the real one on disk, so it is the one the delete has to target.
    await waitFor(() => expect(deletePath).toHaveBeenCalledWith(EPSILON_PATH))
    expect(await screen.findByText("Mod deleted successfully!")).toBeTruthy()
  })
})

describe("ManageMods: icon cache", () => {
  it("clears the mod icon memory cache when leaving the page", async () => {
    const rendered = renderManageMods()

    await screen.findByText("Alpha Mod", {}, { timeout: 3000 })
    const clearCache = window.api.modsManager.clearModIconMemoryCache
    expect(clearCache).not.toHaveBeenCalled()

    rendered.unmount()
    expect(clearCache).toHaveBeenCalledTimes(1)

    cleanup()
  })
})
