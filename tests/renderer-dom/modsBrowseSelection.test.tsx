import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Link, Route, Routes, useLocation } from "react-router-dom"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { getModsBrowseState, updateModsBrowseState } from "@renderer/features/mods/modsBrowseState"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"
import { MAX_MOD_SELECTION } from "@domain/mods/modSelection"

import { createMockConfig, installMockWindowApi, type WindowApiOverrides } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Picking several Mods on the browse page and installing them in one run (#287).
 *
 * The run itself is the modpack import's table, pinned in importModpackPopup.test.tsx. This suite
 * pins what the page adds around it: selection mode, what a card click does in it, how picks live
 * across filters, paging and navigation, and the snapshot of the folder the run plans against.
 */

const SELECT = "Select Mods to install together"

function aListing(modid: number, name: string, modidstr: string): Record<string, unknown> {
  return { modid, assetid: modid, name, summary: "", modidstrs: [modidstr], author: "Someone", downloads: 42, follows: 7, comments: 1, side: "both", logo: "", tags: [] }
}

const BETTER_RUINS = aListing(123, "Better Ruins", "betterruins")
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

const DETAILS: Record<number, object> = {
  123: aDetail(123, "Better Ruins", [aRelease("betterruins", "2.0.0", ["1.21.0"])]),
  789: aDetail(789, "Deeper Caves", [aRelease("deepercaves", "1.5.0", ["1.21.0"]), aRelease("deepercaves", "1.0.0", ["1.21.0"])])
}

function aCopy(modid: string, name: string, version: string): InstalledModType {
  return { name, modid, version, path: `/games/a/Mods/${modid}-${version}.zip`, enabled: true }
}

function anInstallation(): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.21.0",
    gameVersionId: "gv-1",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: ""
  }
}

function Where(): JSX.Element {
  return <output data-testid="where">{useLocation().pathname}</output>
}

interface MountOptions {
  /** null for a fresh profile that has not picked an Installation yet. */
  installation?: InstallationType | null
  /** The `/api/mods` answer, or a function of the request URL for a search that narrows it. */
  catalog?: Record<string, unknown>[] | ((url: string) => Record<string, unknown>[])
  /** What the Mods folder at `path` holds each time it is scanned. */
  folder?: (path: string) => InstalledModType[] | Promise<InstalledModType[]>
  pathsManager?: WindowApiOverrides["pathsManager"]
  /** More Installations, with a button standing in for the sidebar that switches to the first. */
  others?: InstallationType[]
}

function SwitchInstallation({ to }: Readonly<{ to: string }>): JSX.Element {
  const dispatch = useConfigDispatch()
  return <button onClick={() => dispatch({ type: CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION, payload: to })}>Switch Installation</button>
}

function mount({ installation = anInstallation(), catalog = [BETTER_RUINS, DEEPER_CAVES], folder = (): InstalledModType[] => [], pathsManager, others = [] }: MountOptions = {}): {
  getInstalledMods: ReturnType<typeof vi.fn>
  downloadOnPath: ReturnType<typeof vi.fn>
  deletePath: ReturnType<typeof vi.fn>
  lookupsOf: (listingId: number) => number
} {
  const getInstalledMods = vi.fn(async (path: string) => ({ mods: await folder(path), errors: [] }))
  const queryURL = vi.fn(async (url: string): Promise<string> => {
    if (url.includes("/api/mods")) return JSON.stringify({ statuscode: "200", mods: typeof catalog === "function" ? catalog(url) : catalog })
    const id = /\/api\/mod\/(\d+)$/.exec(url)?.[1]
    if (id === undefined) return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
    return JSON.stringify(DETAILS[Number(id)] ?? { statuscode: "404" })
  })
  const downloadOnPath = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(async (_id, _url, outputPath, fileName) => `${outputPath}/${fileName}`)
  const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)

  installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: installation?.id ?? null, installations: [...(installation ? [installation] : []), ...others] }))
    },
    modsManager: { getInstalledMods },
    pathsManager: { checkPathExists: vi.fn(async () => true), deletePath, downloadOnPath, ...pathsManager },
    netManager: { queryURL }
  })

  renderWithProviders(
    <TaskProvider>
      {others[0] && <SwitchInstallation to={others[0].id} />}
      <Routes>
        <Route path="/mods" element={<ListMods />} />
        <Route path="/mods/install/:modid" element={<Where />} />
        <Route path="/" element={<Link to="/mods">Back to the Mods</Link>} />
      </Routes>
    </TaskProvider>,
    { route: "/mods" }
  )

  const lookupsOf = (listingId: number): number => queryURL.mock.calls.filter(([url]) => url.endsWith(`/api/mod/${listingId}`)).length
  return { getInstalledMods, downloadOnPath, deletePath, lookupsOf }
}

function toggle(): HTMLElement {
  return screen.getByRole("button", { name: SELECT })
}

function card(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}, `) })
}

function selectionStatus(): string | null {
  return screen.getByRole("status").textContent
}

async function openTable(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Install selected" }))
  return screen.findByRole("dialog")
}

function rowIn(dialog: HTMLElement, label: string): HTMLElement {
  return within(dialog).getByText(label).closest("li") as HTMLElement
}

describe("ModDB browse selection", () => {
  it("the Select toggle turns cards into pressable picks and a card click picks instead of opening the mod", async () => {
    const user = userEvent.setup()
    mount()

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    expect(card("Better Ruins").getAttribute("aria-pressed")).toBeNull()
    expect(screen.getByRole("group", { name: "Better Ruins" })).toBeTruthy()
    expect(toggle().getAttribute("aria-pressed")).toBe("false")

    await user.click(toggle())
    expect(toggle().getAttribute("aria-pressed")).toBe("true")
    expect(card("Better Ruins").getAttribute("aria-pressed")).toBe("false")
    // The action strip goes while selecting, so a card never offers two ways to act on its Mod.
    expect(screen.queryByRole("group", { name: "Better Ruins" })).toBeNull()

    await user.click(card("Better Ruins"))
    expect(card("Better Ruins").getAttribute("aria-pressed")).toBe("true")
    expect(card("Deeper Caves").getAttribute("aria-pressed")).toBe("false")
    expect(selectionStatus()).toBe("1 selected")
    expect(screen.queryByTestId("where")).toBeNull()

    card("Better Ruins").focus()
    await user.keyboard(" ")
    expect(card("Better Ruins").getAttribute("aria-pressed")).toBe("false")
    expect(selectionStatus()).toBe("0 selected")
  }, 15_000)

  it("keeps picks across a search change and the table names picks the filter hides", async () => {
    const user = userEvent.setup()
    mount({ catalog: (url) => (url.includes("text=caves") ? [DEEPER_CAVES] : [BETTER_RUINS, DEEPER_CAVES]) })

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Better Ruins"))

    await user.type(screen.getByPlaceholderText("Text"), "caves")
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Better Ruins, / })).toBeNull(), { timeout: 3000 })
    await user.click(card("Deeper Caves"))
    expect(selectionStatus()).toBe("2 selected")

    const dialog = await openTable(user)
    await waitFor(() => expect(within(dialog).getAllByText("New install")).toHaveLength(2), { timeout: 3000 })
    expect(rowIn(dialog, "Better Ruins")).toBeTruthy()
    expect(rowIn(dialog, "Deeper Caves")).toBeTruthy()
  }, 15_000)

  it("Select every Mod shown picks the rendered cards only", async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 60 }, (_, index) => aListing(1000 + index, `Mod ${1000 + index}`, `mod${1000 + index}`))
    mount({ catalog: many })

    await screen.findByRole("button", { name: "Mod 1000, Not installed" }, { timeout: 3000 })
    expect(screen.getAllByRole("button", { name: /^Mod \d+, Not installed$/ })).toHaveLength(45)
    await user.click(toggle())
    await user.click(screen.getByRole("button", { name: "Select every Mod shown" }))

    expect(selectionStatus()).toBe("45 selected")
    expect(getModsBrowseState().picks.map((pick) => pick.listingId)).toEqual(many.slice(0, 45).map((mod) => mod.modid))

    await user.click(screen.getByRole("button", { name: "Select every Mod shown" }))
    expect(selectionStatus()).toBe("45 selected")
  }, 15_000)

  it("Clear selection empties the picks, and leaving selection mode clears them too", async () => {
    const user = userEvent.setup()
    mount()

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Better Ruins"))
    await user.click(screen.getByRole("button", { name: "Clear selection" }))
    expect(selectionStatus()).toBe("0 selected")
    expect(card("Better Ruins").getAttribute("aria-pressed")).toBe("false")

    await user.click(card("Better Ruins"))
    await user.click(toggle())
    expect(screen.queryByRole("status")).toBeNull()
    expect(card("Better Ruins").getAttribute("aria-pressed")).toBeNull()

    await user.click(toggle())
    expect(selectionStatus()).toBe("0 selected")
    expect(card("Better Ruins").getAttribute("aria-pressed")).toBe("false")
  }, 15_000)

  it("restores selection mode and picks after leaving the page and coming back (#415)", async () => {
    const user = userEvent.setup()
    mount()

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Better Ruins"))

    await user.click(screen.getByRole("link", { name: "Go back" }))
    await user.click(await screen.findByRole("link", { name: "Back to the Mods" }))

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    expect(toggle().getAttribute("aria-pressed")).toBe("true")
    expect(selectionStatus()).toBe("1 selected")
    expect(card("Better Ruins").getAttribute("aria-pressed")).toBe("true")
  }, 15_000)

  it("at 100 picks an unpicked card is aria-disabled and a click leaves the count at 100, while a picked card still unpicks", async () => {
    const user = userEvent.setup()
    const elsewhere = Array.from({ length: MAX_MOD_SELECTION - 1 }, (_, index) => ({ listingId: 5000 + index, name: `Elsewhere ${index}`, modidstrs: [`elsewhere${index}`] }))
    updateModsBrowseState({ selecting: true, picks: [{ listingId: 123, name: "Better Ruins", modidstrs: ["betterruins"] }, ...elsewhere], visibleMods: 110 })
    mount()

    await screen.findByRole("button", { name: "Deeper Caves, Not installed" }, { timeout: 3000 })
    expect(card("Deeper Caves").getAttribute("aria-disabled")).toBe("true")
    expect(card("Deeper Caves").tabIndex).toBe(-1)
    expect(selectionStatus()).toBe("100 selectedYou can pick up to 100 Mods at a time.")

    await user.click(card("Deeper Caves"))
    expect(card("Deeper Caves").getAttribute("aria-pressed")).toBe("false")
    expect(selectionStatus()).toMatch(/^100 selected/)

    await user.click(card("Better Ruins"))
    expect(card("Better Ruins").getAttribute("aria-pressed")).toBe("false")
    expect(selectionStatus()).toBe("99 selected")
    expect(card("Deeper Caves").getAttribute("aria-disabled")).toBeNull()
  }, 15_000)

  it("Install selected is disabled with no picks, and enabled once something is picked", async () => {
    const user = userEvent.setup()
    mount()

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(toggle())
    const installSelected = (): HTMLButtonElement => screen.getByRole("button", { name: "Install selected" })
    expect(installSelected().disabled).toBe(true)

    await user.click(card("Better Ruins"))
    expect(installSelected().disabled).toBe(false)
  }, 15_000)

  it("Install selected stays disabled with no Installation selected", async () => {
    const user = userEvent.setup()
    mount({ installation: null })

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Better Ruins"))
    expect((screen.getByRole("button", { name: "Install selected" }) as HTMLButtonElement).disabled).toBe(true)
  }, 15_000)

  it("plans against the Mods folder as it is when Install selected is pressed, not as the grid last read it", async () => {
    const user = userEvent.setup()
    let folder: InstalledModType[] = []
    const { downloadOnPath } = mount({ folder: () => folder })

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Better Ruins"))
    // Put there behind the page's back, by hand or by another launcher: nothing rescans the grid.
    folder = [aCopy("BetterRuins", "Better Ruins", "2.0.0")]

    const dialog = await openTable(user)
    await waitFor(() => expect(within(rowIn(dialog, "Better Ruins")).getByText("Already installed")).toBeTruthy(), { timeout: 3000 })
    await user.click(within(dialog).getByRole("button", { name: "Install" }))
    await screen.findByRole("heading", { name: "Mod Install Summary" }, { timeout: 3000 })
    expect(downloadOnPath).not.toHaveBeenCalled()
  }, 15_000)

  it("switching Installation while Install selected reads the folder drops the run, and the next press installs into the new one only", async () => {
    const user = userEvent.setup()
    const other = { ...anInstallation(), id: "install-b", name: "Install B", path: "/games/b" }
    let holdA = false
    let releaseA!: () => void
    const { getInstalledMods, downloadOnPath, deletePath } = mount({
      others: [other],
      folder: async (path) => {
        if (!path.includes("/games/a")) return []
        if (holdA) await new Promise<void>((resolve) => (releaseA = resolve))
        return [aCopy("deepercaves", "Deeper Caves", "1.0.0")]
      }
    })
    const installSelected = (): HTMLButtonElement => screen.getByRole("button", { name: "Install selected" })

    await screen.findByRole("button", { name: "Deeper Caves, Installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Deeper Caves"))

    holdA = true
    await user.click(installSelected())
    // Busy while the folder is read, so a second press cannot start a second run.
    expect(installSelected().getAttribute("aria-busy")).toBe("true")
    expect(installSelected().disabled).toBe(true)

    await user.click(screen.getByRole("button", { name: "Switch Installation" }))
    await waitFor(() => expect(getInstalledMods.mock.calls.some(([path]) => String(path).includes("/games/b"))).toBe(true), { timeout: 3000 })
    holdA = false
    await act(async () => releaseA())
    await waitFor(() => expect(installSelected().getAttribute("aria-busy")).not.toBe("true"), { timeout: 3000 })

    // A's folder read never becomes a run on B, which would delete A's archive and download into B.
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(selectionStatus()).toBe("1 selected")

    const dialog = await openTable(user)
    await waitFor(() => expect(within(rowIn(dialog, "Deeper Caves")).getByText("New install")).toBeTruthy(), { timeout: 3000 })
    await user.click(within(dialog).getByRole("button", { name: "Install" }))
    await screen.findByRole("heading", { name: "Mod Install Summary" }, { timeout: 3000 })

    expect(deletePath).not.toHaveBeenCalled()
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
    expect(downloadOnPath).toHaveBeenCalledWith(expect.any(String), "https://mods.example/deepercaves-1.5.0.zip", "/games/b/Mods", "deepercaves-1.5.0.zip")
  }, 20_000)

  it("a run installs into the Installation whose folder it read, even if the selection moves while the table is open", async () => {
    const user = userEvent.setup()
    const other = { ...anInstallation(), id: "install-b", name: "Install B", path: "/games/b" }
    const { downloadOnPath, deletePath } = mount({ others: [other], folder: (path) => (path.includes("/games/a") ? [aCopy("deepercaves", "Deeper Caves", "1.0.0")] : []) })

    await screen.findByRole("button", { name: "Deeper Caves, Installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Deeper Caves"))
    const dialog = await openTable(user)
    await waitFor(() => expect(within(rowIn(dialog, "Deeper Caves")).getByText("Update from 1.0.0 to 1.5.0")).toBeTruthy(), { timeout: 3000 })

    // The dialog keeps the sidebar out of reach; this stands in for anything else that moves it.
    fireEvent.click(screen.getByRole("button", { name: "Switch Installation", hidden: true }))
    await user.click(within(dialog).getByRole("button", { name: "Install" }))
    await screen.findByRole("heading", { name: "Mod Install Summary" }, { timeout: 3000 })

    expect(deletePath).toHaveBeenCalledWith("/games/a/Mods/deepercaves-1.0.0.zip")
    expect(downloadOnPath).toHaveBeenCalledWith(expect.any(String), "https://mods.example/deepercaves-1.5.0.zip", "/games/a/Mods", "deepercaves-1.5.0.zip")
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
  }, 20_000)

  it("two installed picks, two outcomes: a current copy reads Already installed and is not downloaded, an older one reads Update from X to Y", async () => {
    const user = userEvent.setup()
    // The folder's modinfo spells Better Ruins' id in its own casing; the listing says "betterruins".
    const { downloadOnPath, deletePath } = mount({ folder: () => [aCopy("BetterRuins", "Better Ruins", "2.0.0"), aCopy("deepercaves", "Deeper Caves", "1.0.0")] })

    await screen.findByRole("button", { name: "Better Ruins, Installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Better Ruins"))
    await user.click(card("Deeper Caves"))

    const dialog = await openTable(user)
    await waitFor(() => expect(within(rowIn(dialog, "Better Ruins")).getByText("Already installed")).toBeTruthy(), { timeout: 3000 })
    expect(within(rowIn(dialog, "Deeper Caves")).getByText("Update from 1.0.0 to 1.5.0")).toBeTruthy()

    await user.click(within(dialog).getByRole("button", { name: "Install" }))
    await screen.findByRole("heading", { name: "Mod Install Summary" }, { timeout: 3000 })

    expect(downloadOnPath).toHaveBeenCalledTimes(1)
    expect(downloadOnPath).toHaveBeenCalledWith(expect.any(String), "https://mods.example/deepercaves-1.5.0.zip", "/games/a/Mods", "deepercaves-1.5.0.zip")
    expect(deletePath).toHaveBeenCalledTimes(1)
    expect(deletePath).toHaveBeenCalledWith("/games/a/Mods/deepercaves-1.0.0.zip")
  }, 15_000)

  it("a pick whose Mod is installed twice reads the card's several-copies notice and touches neither copy", async () => {
    const user = userEvent.setup()
    const spare = { ...aCopy("deepercaves", "Deeper Caves", "1.0.0"), enabled: false, path: "/games/a/Mods/deepercaves-1.0.0.zip.disabled" }
    const { downloadOnPath, deletePath, lookupsOf } = mount({ folder: () => [spare, aCopy("deepercaves", "Deeper Caves", "1.4.0"), aCopy("betterruins", "Better Ruins", "1.0.0")] })

    await screen.findByRole("button", { name: "Better Ruins, Installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Deeper Caves"))
    await user.click(card("Better Ruins"))

    const dialog = await openTable(user)
    await waitFor(() => expect(within(rowIn(dialog, "Better Ruins")).getByText("Update from 1.0.0 to 2.0.0")).toBeTruthy(), { timeout: 3000 })
    expect(within(rowIn(dialog, "Deeper Caves")).getByText("Several copies are installed. Sort them out in Manage Mods.")).toBeTruthy()

    await user.click(within(dialog).getByRole("button", { name: "Install" }))
    await screen.findByRole("heading", { name: "Mod Install Summary" }, { timeout: 3000 })

    expect(deletePath).toHaveBeenCalledTimes(1)
    expect(deletePath).toHaveBeenCalledWith("/games/a/Mods/betterruins-1.0.0.zip")
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
    expect(downloadOnPath).toHaveBeenCalledWith(expect.any(String), "https://mods.example/betterruins-2.0.0.zip", "/games/a/Mods", "betterruins-2.0.0.zip")
    expect(lookupsOf(789)).toBe(0)
  }, 20_000)

  it("a download finishing mid-run does not re-send the lookups", async () => {
    const user = userEvent.setup()
    const { getInstalledMods, lookupsOf } = mount()

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Better Ruins"))
    await user.click(card("Deeper Caves"))

    const dialog = await openTable(user)
    await waitFor(() => expect(within(dialog).getAllByText("New install")).toHaveLength(2), { timeout: 3000 })
    const scans = getInstalledMods.mock.calls.length

    await user.click(within(dialog).getByRole("button", { name: "Install" }))
    await screen.findByRole("heading", { name: "Mod Install Summary" }, { timeout: 3000 })
    // Every finished download rescans the folder, and each scan hands the page a new list.
    await waitFor(() => expect(getInstalledMods.mock.calls.length).toBeGreaterThanOrEqual(scans + 2), { timeout: 3000 })
    await act(async () => {})

    expect(lookupsOf(123)).toBe(1)
    expect(lookupsOf(789)).toBe(1)
  }, 15_000)

  it("closing the table before installing keeps the picks", async () => {
    const user = userEvent.setup()
    mount()

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Better Ruins"))
    const dialog = await openTable(user)
    await within(dialog).findByText("New install", {}, { timeout: 3000 })

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 3000 })
    expect(selectionStatus()).toBe("1 selected")
    expect(toggle().getAttribute("aria-pressed")).toBe("true")
  }, 15_000)

  it("closing the summary leaves selection mode and puts focus on the Select toggle", async () => {
    const user = userEvent.setup()
    mount()

    await screen.findByRole("button", { name: "Better Ruins, Not installed" }, { timeout: 3000 })
    await user.click(toggle())
    await user.click(card("Better Ruins"))
    const dialog = await openTable(user)
    await within(dialog).findByText("New install", {}, { timeout: 3000 })
    await user.click(within(dialog).getByRole("button", { name: "Install" }))
    await screen.findByRole("heading", { name: "Mod Install Summary" }, { timeout: 3000 })

    await user.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 3000 })

    expect(toggle().getAttribute("aria-pressed")).toBe("false")
    expect(screen.queryByRole("button", { name: "Install selected" })).toBeNull()
    expect(getModsBrowseState()).toMatchObject({ selecting: false, picks: [] })
    await waitFor(() => expect(document.activeElement).toBe(toggle()))
  }, 15_000)
})
