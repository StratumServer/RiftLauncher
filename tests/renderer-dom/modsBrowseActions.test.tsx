import { afterEach, describe, expect, it, vi } from "vitest"
import { act, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Link, Route, Routes, useLocation } from "react-router-dom"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { getModsBrowseState, resetModsBrowseState, updateModsBrowseState } from "@renderer/features/mods/modsBrowseState"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI, type WindowApiOverrides } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const QUICK_INSTALL = "Install the newest release made for this Installation's Vintage Story version"
const ENABLED = "Enabled: Vintage Story loads this Mod"
const SUSPENDED = "Updates suspended: Update all skips this Mod"

function aListing(modid: number, name: string, modidstr: string): Record<string, unknown> {
  return { modid, assetid: modid, name, summary: "", modidstrs: [modidstr], author: "Someone", downloads: 42, follows: 7, comments: 1, side: "both", logo: "", tags: [] }
}

const BETTER_RUINS = aListing(123, "Better Ruins", "betterruins")
const PRIMITIVE_SURVIVAL = aListing(456, "Primitive Survival", "primitivesurvival")
const DEEPER_CAVES = aListing(789, "Deeper Caves", "deepercaves")

function aRelease(modidstr: string, modversion: string, tags: string[]): DownloadableModReleaseType {
  return {
    releaseid: 1,
    mainfile: `https://mods.example/${modidstr}-${modversion}.zip`,
    filename: `${modidstr}-${modversion}.zip`,
    fileid: 1,
    downloads: 0,
    tags,
    modidstr,
    modversion,
    created: "2026-01-01",
    changelog: ""
  }
}

/** One `/api/mod/{id}` answer. Releases come newest first, the order the ModDB serves them in. */
function aDetail(modid: number, name: string, releases: DownloadableModReleaseType[]): object {
  return { statuscode: "200", mod: { modid, assetid: modid, name, text: "", author: "Someone", tags: [], releases } }
}

function aCopy(modid: string, name: string, version: string, enabled = true): InstalledModType {
  return { name, modid, version, path: `/games/a/Mods/${modid}-${version}.zip${enabled ? "" : ".disabled"}`, enabled }
}

/** Two registered builds, so a rule judging against the first one instead of the referenced one shows. */
const GAME_VERSIONS = [
  { id: "gv-1", version: "1.20.0", path: "/versions/1.20.0" },
  { id: "gv-2", version: "1.21.0", path: "/versions/1.21.0" }
]

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.21.0",
    gameVersionId: "gv-2",
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

/** Every notification the player was shown: the one on screen, and those the center keeps. */
function Notifications(): JSX.Element {
  const { activeToast, history } = useNotificationsContext()
  return (
    <div>
      <output data-testid="toast">{activeToast?.body ?? ""}</output>
      <div data-testid="history">
        {history.map((record) => (
          <p key={record.id}>{record.body}</p>
        ))}
      </div>
    </div>
  )
}

function historyBodies(): (string | null)[] {
  return [...screen.getByTestId("history").children].map((node) => node.textContent)
}

function Where(): JSX.Element {
  return (
    <>
      <output data-testid="where">{useLocation().pathname}</output>
      <Link to="/mods">Back to Mods</Link>
    </>
  )
}

interface MountOptions {
  /** null for a fresh profile that has not picked an Installation yet. */
  installation?: InstallationType | null
  catalog?: Record<string, unknown>[]
  /** What the Mods folder holds each time it is scanned. */
  folder?: () => InstalledModType[] | Promise<InstalledModType[]>
  /** `/api/mod/{id}` answers by id. An Error is a lookup that never got an answer, a missing id a 404. */
  details?: Record<number, object | Error>
  modsManager?: WindowApiOverrides["modsManager"]
  pathsManager?: WindowApiOverrides["pathsManager"]
  routes?: boolean
}

function mount({ installation = anInstallation(), catalog = [BETTER_RUINS], folder = (): InstalledModType[] => [], details = {}, modsManager, pathsManager, routes = false }: MountOptions = {}): {
  api: MockedBridgeAPI
  getInstalledMods: ReturnType<typeof vi.fn>
  detailLookups: () => string[]
} {
  const getInstalledMods = vi.fn(async () => ({ mods: await folder(), errors: [] }))
  const queryURL = vi.fn(async (url: string): Promise<string> => {
    if (url.includes("/api/mods")) return JSON.stringify({ statuscode: "200", mods: catalog })
    const id = /\/api\/mod\/(\d+)$/.exec(url)?.[1]
    if (id === undefined) return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
    const answer = details[Number(id)]
    if (answer instanceof Error) throw answer
    return JSON.stringify(answer ?? { statuscode: "404" })
  })

  const api = installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: installation?.id ?? null, installations: installation ? [installation] : [], gameVersions: GAME_VERSIONS }))
    },
    modsManager: { getInstalledMods, ...modsManager },
    pathsManager: { ...pathsManager },
    netManager: { queryURL }
  })

  const page = (
    <>
      <ListMods />
      <Notifications />
    </>
  )
  renderWithProviders(
    <TaskProvider>
      {routes ? (
        <Routes>
          <Route path="/mods" element={page} />
          <Route path="/mods/install/:modid" element={<Where />} />
        </Routes>
      ) : (
        page
      )}
    </TaskProvider>,
    { route: "/mods" }
  )

  const detailLookups = (): string[] =>
    queryURL.mock.calls
      .map(([url]) => url)
      .filter((url) => /\/api\/mod\/\d+$/.test(url))
      .sort()
  return { api, getInstalledMods, detailLookups }
}

function strip(name: string): HTMLElement {
  return screen.getByRole("group", { name })
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  resetModsBrowseState()
})

describe("ModDB card actions: no Installation", () => {
  it("shows no card actions and says once that no Installation is selected", async () => {
    mount({ installation: null, catalog: [BETTER_RUINS, PRIMITIVE_SURVIVAL] })

    await screen.findByRole("button", { name: "Primitive Survival, Not installed" }, { timeout: 3000 })

    // The config selects the first Installation whenever there is one, so none selected means none at all.
    expect(screen.getAllByText(/No Installations found!/)).toHaveLength(1)
    expect(screen.getByRole("link", { name: "Installations" }).getAttribute("href")).toBe("/installations")
    expect(screen.queryAllByRole("group")).toHaveLength(0)
    for (const card of screen.getAllByRole("listitem")) expect(within(card).getAllByRole("button")).toHaveLength(3)
  })
})

describe("ModDB card actions: quick install", () => {
  it("quick-installs the newest release tagged for the build the Installation references", async () => {
    const user = userEvent.setup()
    let folder: InstalledModType[] = []
    const downloadOnPath = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(async (_id, _url, outputPath, fileName) => {
      folder = [aCopy("betterruins", "Better Ruins", "2.0.0")]
      return `${outputPath}/${fileName}`
    })
    const releases = [aRelease("betterruins", "3.0.0", ["1.22.0"]), aRelease("betterruins", "2.0.0", ["1.21.0"]), aRelease("betterruins", "1.0.0", ["1.20.0"])]
    mount({ folder: () => folder, details: { 123: aDetail(123, "Better Ruins", releases) }, pathsManager: { downloadOnPath } })

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(within(strip("Better Ruins")).getByRole("button", { name: QUICK_INSTALL }))

    await waitFor(() => expect(downloadOnPath).toHaveBeenCalledWith(expect.any(String), "https://mods.example/betterruins-2.0.0.zip", "/games/a/Mods", "betterruins-2.0.0.zip"))
    expect(await screen.findByRole("button", { name: "Better Ruins, Installed" }, { timeout: 3000 })).toBeTruthy()

    // The download task's own completion toast is the one notification the player gets.
    await waitFor(() => expect(screen.getByTestId("toast").textContent).toMatch(/Better Ruins/))
    expect(historyBodies()).toEqual([])
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
  }, 15_000)

  it("falls through to the release list when no release is tagged for the build", async () => {
    const user = userEvent.setup()
    const downloadOnPath = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(async () => "")
    mount({ details: { 123: aDetail(123, "Better Ruins", [aRelease("betterruins", "1.0.0", ["1.19.0"])]) }, pathsManager: { downloadOnPath }, routes: true })

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(within(strip("Better Ruins")).getByRole("button", { name: QUICK_INSTALL }))

    expect((await screen.findByTestId("where")).textContent).toBe("/mods/install/123")
    expect(downloadOnPath).not.toHaveBeenCalled()
    expect(screen.queryByTestId("toast")?.textContent ?? "").toBe("")
  }, 15_000)

  it.each([
    ["the lookup never gets an answer", new Error("getaddrinfo ENOTFOUND mods.vintagestory.at")],
    ["the ModDB answers 404", undefined]
  ])(
    "says the version list could not be loaded when %s",
    async (_case, answer) => {
      const user = userEvent.setup()
      const downloadOnPath = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(async () => "")
      mount({ details: answer ? { 123: answer } : {}, pathsManager: { downloadOnPath } })

      await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
      await user.click(within(strip("Better Ruins")).getByRole("button", { name: QUICK_INSTALL }))

      await waitFor(() => expect(historyBodies()).toEqual(["This Mod's version list couldn't be loaded. Check your connection and try again."]))
      expect(downloadOnPath).not.toHaveBeenCalled()
    },
    15_000
  )

  it("starts one download when Install is clicked twice inside one commit", async () => {
    const download = deferred<string>()
    const downloadOnPath = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(() => download.promise)
    const { detailLookups } = mount({ details: { 123: aDetail(123, "Better Ruins", [aRelease("betterruins", "2.0.0", ["1.21.0"])]) }, pathsManager: { downloadOnPath } })

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    const install = within(strip("Better Ruins")).getByRole("button", { name: QUICK_INSTALL })
    act(() => {
      install.click()
      install.click()
    })

    await waitFor(() => expect(downloadOnPath).toHaveBeenCalledTimes(1))
    expect(detailLookups()).toEqual(["https://mods.vintagestory.at/api/mod/123"])

    // A download in flight holds its Mod for every page, so this one lands before the next test.
    await act(async () => download.resolve("/games/a/Mods/betterruins-2.0.0.zip"))
    await waitFor(() => expect((within(strip("Better Ruins")).getByRole("button", { name: QUICK_INSTALL }) as HTMLButtonElement).disabled).toBe(false))
  }, 15_000)
})

describe("ModDB card actions: one installed copy", () => {
  it("disables an installed Mod from its card, then rescans, leaving the browse position alone", async () => {
    const user = userEvent.setup()
    vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => {})
    updateModsBrowseState({ visibleMods: 40, scrollTop: 120 })
    let folder = [aCopy("betterruins", "Better Ruins", "1.0.0")]
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string) => {
      folder = [aCopy("betterruins", "Better Ruins", "1.0.0", false)]
      return { ok: true, path: `${path}.disabled` }
    })
    const { getInstalledMods } = mount({ folder: () => folder, modsManager: { setModEnabled } })

    await screen.findByRole("button", { name: "Better Ruins, Installed" }, { timeout: 3000 })
    const enabled = within(strip("Better Ruins")).getByRole("button", { name: ENABLED })
    expect(enabled.getAttribute("aria-pressed")).toBe("true")
    const scans = getInstalledMods.mock.calls.length

    await user.click(enabled)

    const card = await screen.findByRole("button", { name: "Better Ruins, Installed, Disabled" }, { timeout: 3000 })
    expect(setModEnabled).toHaveBeenCalledTimes(1)
    expect(setModEnabled).toHaveBeenCalledWith("/games/a/Mods/betterruins-1.0.0.zip", false)
    expect(getInstalledMods.mock.calls.length).toBeGreaterThan(scans)
    expect(within(strip("Better Ruins")).getByRole("button", { name: ENABLED }).getAttribute("aria-pressed")).toBe("false")
    expect(within(card.closest("li") as HTMLElement).getByText("Disabled")).toBeTruthy()
    expect(historyBodies()).toEqual(["Better Ruins is disabled and will not be loaded!"])
    expect(getModsBrowseState()).toMatchObject({ visibleMods: 40, scrollTop: 120 })
  }, 15_000)

  it("sends one rename when Enabled is clicked twice, and keeps the card's other actions off until the rescan lands", async () => {
    let folder = [aCopy("betterruins", "Better Ruins", "1.0.0")]
    let scanGate: Promise<void> = Promise.resolve()
    const rename = deferred<SetModEnabledResult>()
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(() => rename.promise)
    mount({
      folder: async () => {
        await scanGate
        return folder
      },
      modsManager: { setModEnabled }
    })

    await screen.findByRole("button", { name: "Better Ruins, Installed" }, { timeout: 3000 })
    const enabled = within(strip("Better Ruins")).getByRole("button", { name: ENABLED })
    act(() => {
      enabled.click()
      enabled.click()
    })

    expect(setModEnabled).toHaveBeenCalledTimes(1)
    const remove = within(strip("Better Ruins")).getByRole("button", { name: "Delete" }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)

    const rescan = deferred<void>()
    scanGate = rescan.promise
    folder = [aCopy("betterruins", "Better Ruins", "1.0.0", false)]
    await act(async () => rename.resolve({ ok: true, path: "/games/a/Mods/betterruins-1.0.0.zip.disabled" }))
    expect((within(strip("Better Ruins")).getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => rescan.resolve())
    await screen.findByRole("button", { name: "Better Ruins, Installed, Disabled" }, { timeout: 3000 })
    expect((within(strip("Better Ruins")).getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false)
    expect(setModEnabled).toHaveBeenCalledTimes(1)
  }, 15_000)

  it("logs no path and no Mod name when a rename is refused", async () => {
    const user = userEvent.setup()
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async () => ({ ok: false, reason: "name-taken" }))
    const { api } = mount({ folder: () => [aCopy("betterruins", "Better Ruins", "1.0.0")], modsManager: { setModEnabled } })

    await screen.findByRole("button", { name: "Better Ruins, Installed" }, { timeout: 3000 })
    const loggedBefore = vi.mocked(api.utils.logMessage).mock.calls.length
    await user.click(within(strip("Better Ruins")).getByRole("button", { name: ENABLED }))

    await waitFor(() => expect(historyBodies()).toEqual([expect.stringMatching(/There is already another file where Better Ruins would have been renamed/)]))
    const logged = vi
      .mocked(api.utils.logMessage)
      .mock.calls.slice(loggedBefore)
      .map((call) => call.join(" "))
      .join("\n")
    expect(logged).toContain("name-taken")
    expect(logged).not.toContain("/games/a")
    expect(logged).not.toContain("Better Ruins")
  }, 15_000)

  it("suspends updates for one Mod without suspending the other", async () => {
    const user = userEvent.setup()
    const { api } = mount({
      catalog: [BETTER_RUINS, PRIMITIVE_SURVIVAL],
      folder: () => [aCopy("betterruins", "Better Ruins", "1.0.0"), aCopy("primitivesurvival", "Primitive Survival", "3.0.0")]
    })

    await screen.findByRole("button", { name: "Primitive Survival, Installed" }, { timeout: 3000 })
    await user.click(within(strip("Better Ruins")).getByRole("button", { name: SUSPENDED }))

    await waitFor(() => expect(within(strip("Better Ruins")).getByRole("button", { name: SUSPENDED }).getAttribute("aria-pressed")).toBe("true"))
    expect(within(strip("Primitive Survival")).getByRole("button", { name: SUSPENDED }).getAttribute("aria-pressed")).toBe("false")
    await waitFor(() => expect(vi.mocked(api.configManager.saveConfig).mock.lastCall?.[0]).toMatchObject({ suspendedModUpdates: ["betterruins"] }))
    expect(historyBodies()).toEqual([])
  }, 15_000)

  it("deletes an installed Mod by its real file name only after confirming, and keeps focus on the card", async () => {
    const user = userEvent.setup()
    let folder = [aCopy("betterruins", "Better Ruins", "1.0.0", false)]
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => {
      folder = []
      return true
    })
    mount({ folder: () => folder, pathsManager: { deletePath } })

    await screen.findByRole("button", { name: "Better Ruins, Installed, Disabled" }, { timeout: 3000 })
    await user.click(within(strip("Better Ruins")).getByRole("button", { name: "Delete" }))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Are you sure you want to delete this Mod?")).toBeTruthy()
    expect(deletePath).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: "Delete" }))

    expect(deletePath).toHaveBeenCalledTimes(1)
    expect(deletePath).toHaveBeenCalledWith("/games/a/Mods/betterruins-1.0.0.zip.disabled")
    const card = await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await waitFor(() => expect(document.activeElement).toBe(card), { timeout: 3000 })
  }, 15_000)

  it("offers Update only when a newer tagged release exists, and keeps a disabled Mod disabled", async () => {
    const user = userEvent.setup()
    let folder = [aCopy("betterruins", "Better Ruins", "1.0.0", false), aCopy("primitivesurvival", "Primitive Survival", "2.0.0")]
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => {
      folder = folder.slice(1)
      return true
    })
    const downloadOnPath = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(async (_id, _url, outputPath, fileName) => {
      folder = [...folder, aCopy("betterruins", "Better Ruins", "1.5.0", false)]
      return `${outputPath}/${fileName}`
    })
    const { detailLookups } = mount({
      catalog: [BETTER_RUINS, PRIMITIVE_SURVIVAL],
      folder: () => folder,
      details: {
        123: aDetail(123, "Better Ruins", [aRelease("betterruins", "1.5.0", ["1.21.0"]), aRelease("betterruins", "1.0.0", ["1.20.0"])]),
        456: aDetail(456, "Primitive Survival", [aRelease("primitivesurvival", "2.0.0", ["1.21.0"])])
      },
      pathsManager: { deletePath, downloadOnPath }
    })

    const update = await within(await screen.findByRole("group", { name: "Better Ruins" }, { timeout: 3000 })).findByRole("button", { name: "Update to v1.5.0" }, { timeout: 3000 })
    await waitFor(() => expect(detailLookups()).toHaveLength(2))
    await act(async () => {})
    expect(within(strip("Primitive Survival")).queryByRole("button", { name: /^Update to/ })).toBeNull()

    await user.click(update)

    await waitFor(() => expect(downloadOnPath).toHaveBeenCalledWith(expect.any(String), "https://mods.example/betterruins-1.5.0.zip", "/games/a/Mods", "betterruins-1.5.0.zip.disabled"))
    expect(deletePath).toHaveBeenCalledWith("/games/a/Mods/betterruins-1.0.0.zip.disabled")
    expect(deletePath.mock.invocationCallOrder[0]).toBeLessThan(downloadOnPath.mock.invocationCallOrder[0] as number)
    await waitFor(() => expect(within(strip("Better Ruins")).queryByRole("button", { name: /^Update to/ })).toBeNull(), { timeout: 3000 })
    expect(screen.getByRole("button", { name: "Better Ruins, Installed, Disabled" })).toBeTruthy()
    // The download task's toast is the update's one notification.
    await waitFor(() => expect(screen.getByTestId("toast").textContent).toMatch(/Better Ruins/))
    expect(historyBodies()).toEqual([])
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
  }, 15_000)

  it("keeps Install off on a page opened while an update of the Mod is still on its way", async () => {
    const user = userEvent.setup()
    let folder = [aCopy("betterruins", "Better Ruins", "1.0.0", false)]
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => {
      folder = []
      return true
    })
    const download = deferred<void>()
    const downloadOnPath = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(async (_id, _url, outputPath, fileName) => {
      await download.promise
      folder = [aCopy("betterruins", "Better Ruins", "1.5.0", false)]
      return `${outputPath}/${fileName}`
    })
    mount({
      folder: () => folder,
      details: { 123: aDetail(123, "Better Ruins", [aRelease("betterruins", "1.5.0", ["1.21.0"]), aRelease("betterruins", "1.0.0", ["1.20.0"])]) },
      pathsManager: { deletePath, downloadOnPath },
      routes: true
    })

    await user.click(await within(await screen.findByRole("group", { name: "Better Ruins" }, { timeout: 3000 })).findByRole("button", { name: "Update to v1.5.0" }, { timeout: 3000 }))
    await waitFor(() => expect(downloadOnPath).toHaveBeenCalledTimes(1))

    // Off to the release list and back: the old archive is gone and the new one has no name yet.
    await user.click(screen.getByRole("button", { name: "Better Ruins, Installed, Disabled" }))
    await user.click(await screen.findByRole("link", { name: "Back to Mods" }))
    const install = await within(await screen.findByRole("group", { name: "Better Ruins" }, { timeout: 3000 })).findByRole("button", { name: QUICK_INSTALL }, { timeout: 3000 })
    expect(screen.getByRole("button", { name: "Better Ruins, Not installed" })).toBeTruthy()
    expect((install as HTMLButtonElement).disabled).toBe(true)

    await act(async () => download.resolve())
    expect(await screen.findByRole("button", { name: "Better Ruins, Installed, Disabled" }, { timeout: 3000 })).toBeTruthy()
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
  }, 15_000)

  it("refuses card actions while a backup holds the Installation", async () => {
    const user = userEvent.setup()
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string) => ({ ok: true, path }))
    mount({ installation: anInstallation({ _backuping: true }), folder: () => [aCopy("betterruins", "Better Ruins", "1.0.0")], modsManager: { setModEnabled } })

    await screen.findByRole("button", { name: "Better Ruins, Installed" }, { timeout: 3000 })
    await user.click(within(strip("Better Ruins")).getByRole("button", { name: ENABLED }))

    await waitFor(() => expect(historyBodies()).toEqual(["You can't enable or disable a Mod while it's in use."]))
    expect(setModEnabled).not.toHaveBeenCalled()
  }, 15_000)
})

describe("ModDB card actions: several copies and details", () => {
  it("offers no per-copy actions for a Mod installed twice and links to Manage Mods", async () => {
    const { detailLookups } = mount({
      folder: () => [aCopy("betterruins", "Better Ruins", "1.0.0"), aCopy("betterruins", "Better Ruins", "1.0.0", false)],
      details: { 123: aDetail(123, "Better Ruins", [aRelease("betterruins", "1.5.0", ["1.21.0"])]) }
    })

    await screen.findByRole("button", { name: "Better Ruins, Installed" }, { timeout: 3000 })
    const actions = strip("Better Ruins")

    expect(within(actions).queryAllByRole("button")).toHaveLength(0)
    expect(within(actions).getByText(/Several copies are installed/)).toBeTruthy()
    expect(within(actions).getByRole("link", { name: "Manage Mods" }).getAttribute("href")).toBe("/installations/mods/install-a")
    expect(detailLookups()).toEqual([])
  }, 15_000)

  it("looks up ModDB details only for installed Mods on screen, once", async () => {
    const user = userEvent.setup()
    // Two cards on screen: Better Ruins installed, Deeper Caves not. Primitive Survival is installed
    // but past the visible slice.
    updateModsBrowseState({ visibleMods: 2 })
    let folder = [aCopy("betterruins", "Better Ruins", "1.0.0"), aCopy("primitivesurvival", "Primitive Survival", "3.0.0")]
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string) => {
      folder = [aCopy("betterruins", "Better Ruins", "1.0.0", false), folder[1] as InstalledModType]
      return { ok: true, path: `${path}.disabled` }
    })
    const { getInstalledMods, detailLookups } = mount({
      catalog: [BETTER_RUINS, DEEPER_CAVES, PRIMITIVE_SURVIVAL],
      folder: () => folder,
      details: { 123: aDetail(123, "Better Ruins", [aRelease("betterruins", "1.0.0", ["1.21.0"])]) },
      modsManager: { setModEnabled }
    })

    await screen.findByRole("button", { name: "Deeper Caves, Not installed" }, { timeout: 3000 })
    expect(screen.queryByText("Primitive Survival")).toBeNull()
    await waitFor(() => expect(detailLookups()).toEqual(["https://mods.vintagestory.at/api/mod/123"]))

    const scans = getInstalledMods.mock.calls.length
    await user.click(within(strip("Better Ruins")).getByRole("button", { name: ENABLED }))
    await screen.findByRole("button", { name: "Better Ruins, Installed, Disabled" }, { timeout: 3000 })

    expect(getInstalledMods.mock.calls.length).toBeGreaterThan(scans)
    expect(detailLookups()).toEqual(["https://mods.vintagestory.at/api/mod/123"])
  }, 15_000)
})
