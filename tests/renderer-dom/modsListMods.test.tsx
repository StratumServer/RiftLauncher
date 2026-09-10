import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ListMods from "@renderer/features/mods/pages/ListMods"
import InstallMod from "@renderer/features/mods/pages/InstallMod"
import { DEFAULT_LOADED_MODS, getModsBrowseState } from "@renderer/features/mods/modsBrowseState"
import { TASK_NOTIFICATION_POLICIES, TaskProvider, useTaskContext } from "@renderer/contexts/TaskManagerContext"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/** One `/api/mods` entry, just enough of the shape parseModListResponse and ListMods both read. */
const MOD_RESPONSE = {
  statuscode: "200",
  mods: [
    {
      modid: 123,
      assetid: 123,
      name: "Better Ruins",
      summary: "More interesting ruins.",
      modidstrs: ["betterruins"],
      author: "Someone",
      downloads: 42,
      follows: 7,
      comments: 1,
      side: "both",
      logo: "",
      tags: []
    }
  ]
}

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

/**
 * Edits the currently selected installation's path in place, id and
 * lastUsedInstallation untouched, exactly what a "manage installation" flow
 * does while ListMods stays mounted in the background.
 */
function EditInstallationPathButton({ newPath }: { newPath: string }): JSX.Element {
  const configDispatch = useConfigDispatch()
  return <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: "install-a", updates: { path: newPath } } })}>edit installation path</button>
}

/**
 * Queues a download through the same context a mod install goes through, so the task list moves the
 * way it does in the app instead of by a hand-written status.
 */
function StartModDownloadButton(): JSX.Element {
  const { startDownload } = useTaskContext()
  return (
    <button
      onClick={() =>
        void startDownload(
          "Better Ruins",
          "Downloading Better Ruins",
          TASK_NOTIFICATION_POLICIES.individual,
          "https://mods.example/betterruins-1.0.0.zip",
          "/games/a/Mods",
          "betterruins-1.0.0.zip",
          () => {}
        )
      }
    >
      start mod download
    </button>
  )
}

function DownloadStatus(): JSX.Element {
  const { tasks } = useTaskContext()
  return <output data-testid="download-status">{tasks[0]?.status}</output>
}

function installClampedScrollModel(): void {
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 100 })
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return 200 + this.querySelectorAll("li").length * 10
    }
  })
  vi.spyOn(Element.prototype, "scrollTo").mockImplementation(function (this: Element, x: number, y: number): void {
    const scrollTarget = x as number | ScrollToOptions
    const top = typeof scrollTarget === "number" ? y : scrollTarget.top
    if (top !== undefined) this.scrollTop = Math.min(Math.max(top, 0), Math.max(0, this.scrollHeight - this.clientHeight))
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ListMods", () => {
  it("renders results from the mocked ModDB query", async () => {
    installMockWindowApi({
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify(MOD_RESPONSE)
          // authors/gameversions/tags dropdowns query on mount too; an empty named list is enough for them.
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    const modCard = await screen.findByText("Better Ruins", {}, { timeout: 3000 })
    expect(modCard).toBeTruthy()
    expect(screen.getByText("Someone")).toBeTruthy()

    // The ModDB grid can grow into the hundreds on scroll, so its logo image must stay
    // off the initial paint until it nears the viewport.
    expect(screen.getByAltText("Better Ruins").getAttribute("loading")).toBe("lazy")
  })

  it("shows the no-matching-filters state when the ModDB query comes back empty", async () => {
    installMockWindowApi({
      netManager: {
        queryURL: async () => JSON.stringify({ statuscode: "200", mods: [], authors: [], gameversions: [], tags: [] })
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    expect(await screen.findByText("There are no Mods that match your filters!", {}, { timeout: 3000 })).toBeTruthy()
  })

  it("does not let a slower, superseded search overwrite a newer, faster one", async () => {
    const user = userEvent.setup()
    let resolveOldSearch: ((value: string) => void) | undefined

    const queryURL = vi.fn(async (url: string) => {
      if (!url.includes("/api/mods")) return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
      if (url.includes("text=old")) return new Promise<string>((resolve) => (resolveOldSearch = resolve))
      if (url.includes("text=new")) return JSON.stringify({ statuscode: "200", mods: [{ ...MOD_RESPONSE.mods[0], modid: 456, assetid: 456, name: "New Mod" }] })
      return JSON.stringify({ statuscode: "200", mods: [] })
    })

    installMockWindowApi({ netManager: { queryURL } })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    const input = screen.getByPlaceholderText("Text")
    await user.type(input, "old")

    // Waits for the "old" search's debounce to actually fire the request (still unresolved).
    await waitFor(() => expect(resolveOldSearch).toBeTruthy(), { timeout: 3000 })

    await user.clear(input)
    await user.type(input, "new")

    // The newer search resolves and renders while "old" is still pending.
    expect(await screen.findByText("New Mod", {}, { timeout: 3000 })).toBeTruthy()

    // The stale search finally comes back. It must be ignored, not overwrite the current list.
    resolveOldSearch?.(JSON.stringify({ statuscode: "200", mods: [{ ...MOD_RESPONSE.mods[0], name: "Old Mod" }] }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(screen.queryByText("Old Mod")).toBeNull()
    expect(screen.getByText("New Mod")).toBeTruthy()
  })

  it("picks up an edit to the current installation without lastUsedInstallation changing", async () => {
    const user = userEvent.setup()

    // "installed" only for the Mods folder under /games/b, so the mod card's
    // installed styling can only flip once ListMods re-scans with the edited path.
    const getInstalledMods = vi.fn(async (path: string) =>
      path.startsWith("/games/b") ? { mods: [{ name: "Better Ruins", modid: "betterruins", version: "1.0.0", path, enabled: true }], errors: [] } : { mods: [], errors: [] }
    )

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: "install-a", installations: [anInstallation()] }))
      },
      modsManager: { getInstalledMods },
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify(MOD_RESPONSE)
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
        <EditInstallationPathButton newPath="/games/b" />
      </TaskProvider>,
      { route: "/mods" }
    )

    await screen.findByText("Better Ruins", {}, { timeout: 3000 })

    // Scanned the original path on mount, and the card is not shown as installed yet.
    await waitFor(() => expect(getInstalledMods).toHaveBeenCalledWith(expect.stringContaining("/games/a")))
    const cardBefore = screen.getByText("Better Ruins").closest("li")?.firstElementChild as HTMLElement
    expect(cardBefore.className).not.toContain("bg-vsd/50")

    // Edits the installation currently shown, id and lastUsedInstallation both untouched.
    await user.click(screen.getByRole("button", { name: "edit installation path" }))

    // ListMods must derive the edited installation and re-scan its (new) Mods folder,
    // instead of keeping the snapshot it copied in before the edit.
    await waitFor(() => expect(getInstalledMods).toHaveBeenCalledWith(expect.stringContaining("/games/b")))
    await waitFor(() => {
      const cardAfter = screen.getByText("Better Ruins").closest("li")?.firstElementChild as HTMLElement
      expect(cardAfter.className).toContain("bg-vsd/50")
    })
  })

  it("un-favorites a mod on the second click instead of favoriting it a second time", async () => {
    const user = userEvent.setup()

    const api = installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ favMods: [] }))
      },
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify(MOD_RESPONSE)
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    await screen.findByText("Better Ruins", {}, { timeout: 3000 })

    // #414: assert the active state on the icon, not on the button. A hue handed to the
    // ghost FormButton through `className` loses the cascade to the variant's own
    // `text-zinc-200`, so `button.className` still carried "text-yellow-400" while the
    // star rendered grey. The star swaps PiStarDuotone (an interior path at opacity 0.2)
    // for a solid PiStarFill that carries the hue itself.
    const star = (): SVGElement => {
      const svg = screen.getByTitle("Favorite").querySelector("svg")
      if (!svg) throw new Error("favorite star icon not found")
      return svg
    }
    expect(star().getAttribute("class") ?? "").not.toContain("text-yellow-400")
    expect(star().querySelector('path[opacity="0.2"]')).not.toBeNull()

    // configReducer's ADD_FAV_MOD pushes onto favMods without checking for an existing
    // entry: onToggleFavMod only stays correct because it reads a live favMods off its own
    // useCallback dependency array, not a stale closure from the render that first mounted
    // the button. A regression there would either favorite twice in a row (a duplicate modid
    // sitting in favMods) or never flip back, and this round trip is what would catch it.
    await user.click(screen.getByTitle("Favorite"))
    await waitFor(() => expect(api.configManager.saveConfig).toHaveBeenCalled())
    await waitFor(() => {
      const lastSavedConfig = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
      expect(lastSavedConfig?.favMods).toEqual([123])
    })
    expect(star().getAttribute("class")).toContain("text-yellow-400")
    expect(star().querySelector('path[opacity="0.2"]')).toBeNull()

    await user.click(screen.getByTitle("Favorite"))
    await waitFor(() => {
      const lastSavedConfig = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
      expect(lastSavedConfig?.favMods).toEqual([])
    })
    expect(star().getAttribute("class") ?? "").not.toContain("text-yellow-400")
    expect(star().querySelector('path[opacity="0.2"]')).not.toBeNull()
  })

  it("re-reads the installed markers when a mod download finishes", async () => {
    const user = userEvent.setup()

    // Empty when the page arrives, holding the mod once the transfer lands. That is the order the
    // browse flow sees: the install page queues the download and navigates back here long before
    // the archive is on disk.
    let installedMods: InstalledModType[] = []
    const getInstalledMods = vi.fn(async () => ({ mods: installedMods, errors: [] }))

    let downloadId: string | undefined
    let progressHandler: ProgressCallback | undefined
    let finishDownload: ((path: string) => void) | undefined
    const downloadOnPath = vi.fn((id: string) => {
      downloadId = id
      return new Promise<string>((resolve) => (finishDownload = resolve))
    })

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: "install-a", installations: [anInstallation()] }))
      },
      modsManager: { getInstalledMods },
      pathsManager: {
        downloadOnPath,
        onDownloadProgress: vi.fn((callback: ProgressCallback): Unsubscribe => {
          progressHandler = callback
          return () => {}
        })
      },
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify(MOD_RESPONSE)
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
        <StartModDownloadButton />
        <DownloadStatus />
      </TaskProvider>,
      { route: "/mods" }
    )

    await screen.findByText("Better Ruins", {}, { timeout: 3000 })
    await waitFor(() => expect(getInstalledMods).toHaveBeenCalled())
    const scansBeforeInstall = getInstalledMods.mock.calls.length
    expect((screen.getByText("Better Ruins").closest("li")?.firstElementChild as HTMLElement).className).not.toContain("bg-vsd/50")

    await user.click(screen.getByRole("button", { name: "start mod download" }))
    await waitFor(() => expect(finishDownload).toBeTruthy())

    // Electron can report 100 before downloadOnPath resolves. That paints the progress bar, but
    // must not make ListMods scan while the archive is still absent.
    progressHandler?.({ id: downloadId!, progress: 100 })
    await waitFor(() => expect(screen.getByTestId("download-status").textContent).toBe("in-progress"))
    expect(getInstalledMods).toHaveBeenCalledTimes(scansBeforeInstall)

    // From here the archive is on disk, which is the moment the grid's markers went stale.
    installedMods = [{ name: "Better Ruins", modid: "betterruins", version: "1.0.0", path: "/games/a/Mods/betterruins-1.0.0.zip", enabled: true }]
    finishDownload?.("/games/a/Mods/betterruins-1.0.0.zip")

    await waitFor(() => expect(screen.getByTestId("download-status").textContent).toBe("completed"), { timeout: 3000 })
    await waitFor(() => expect(getInstalledMods).toHaveBeenCalledTimes(scansBeforeInstall + 1), { timeout: 3000 })
    await waitFor(() => {
      const card = screen.getByText("Better Ruins").closest("li")?.firstElementChild as HTMLElement
      expect(card.className).toContain("bg-vsd/50")
    })
  })

  it("preserves every browse control and the scroll position after returning from install", async () => {
    const user = userEvent.setup()
    const browseMods = Array.from({ length: 60 }, (_, index) => ({
      modid: 100 + index,
      assetid: 100 + index,
      name: `Mod ${100 + index}`,
      summary: "A browse regression fixture.",
      modidstrs: [`mod-${100 + index}`],
      author: "Author One",
      downloads: 100 - index,
      follows: 200 - index,
      comments: 10,
      side: "server",
      logo: "",
      tags: ["magic"]
    }))
    const installedMods = browseMods.map((mod) => ({
      name: mod.name,
      modid: mod.modidstrs[0]!,
      version: "1.20.0",
      path: `/games/a/Mods/${mod.modidstrs[0]}.zip`,
      enabled: true
    }))
    const queryURL = vi.fn(async (url: string) => {
      if (url.includes("/api/mods")) return JSON.stringify({ statuscode: "200", mods: browseMods })
      if (url.includes("/api/authors")) return JSON.stringify({ statuscode: "200", authors: [{ userid: "author-1", name: "Author One" }] })
      if (url.includes("/api/gameversions")) return JSON.stringify({ statuscode: "200", gameversions: [{ tagid: 1200, name: "1.20.0" }] })
      if (url.includes("/api/tags")) return JSON.stringify({ statuscode: "200", tags: [{ tagid: "tag-magic", name: "magic" }] })
      if (url.includes("/api/mod/100"))
        return JSON.stringify({
          statuscode: "200",
          mod: {
            modid: 100,
            assetid: 100,
            name: "Mod 100",
            releases: [
              {
                releaseid: 1,
                mainfile: "https://mods.example/mod-100.zip",
                filename: "mod-100.zip",
                fileid: 1,
                downloads: 0,
                tags: ["1.20.0"],
                modidstr: "mod-100",
                modversion: "1.0.0",
                created: "2026-01-02T00:00:00Z",
                changelog: ""
              }
            ]
          }
        })
      return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
    })

    window.localStorage.removeItem("listModsOrderBy")
    window.localStorage.removeItem("listModsOrderByOrder")
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            lastUsedInstallation: "install-a",
            installations: [anInstallation()],
            favMods: browseMods.map((mod) => mod.modid)
          })
        )
      },
      modsManager: { getInstalledMods: vi.fn(async () => ({ mods: installedMods, errors: [] })) },
      netManager: { queryURL }
    })

    renderWithProviders(
      <TaskProvider>
        <Routes>
          <Route path="/mods" element={<ListMods />} />
          <Route path="/mods/install/:modid" element={<InstallMod />} />
        </Routes>
      </TaskProvider>,
      { route: "/mods" }
    )

    installClampedScrollModel()
    await screen.findByText("Mod 100", {}, { timeout: 3000 })

    fireEvent.change(screen.getByPlaceholderText("Text"), { target: { value: "needle" } })

    await user.type(screen.getByPlaceholderText("Author"), "Aut")
    await user.click(await screen.findByRole("option", { name: "Author One" }))

    await user.click(screen.getByRole("button", { name: "Versions" }))
    await user.click(await screen.findByRole("option", { name: "1.20.0" }))
    await user.click(screen.getByRole("button", { name: /1\.20\.0/ }))

    await user.click(screen.getByRole("button", { name: "Tags" }))
    await user.click(await screen.findByRole("option", { name: "magic" }))
    await user.click(screen.getByRole("button", { name: /magic/ }))

    await user.click(screen.getByRole("button", { name: "Any" }))
    await user.click(await screen.findByRole("option", { name: "Server" }))

    await user.click(screen.getByRole("button", { name: "All" }))
    await user.click(await screen.findByRole("option", { name: "Installed" }))

    await user.click(screen.getByTitle("Show favorite Mods only"))

    await user.click(screen.getByTitle("Order"))
    await user.click(screen.getByRole("button", { name: "Downloads" }))
    await user.click(screen.getByTitle("Order"))
    await user.click(screen.getByRole("button", { name: "Downloads" }))

    await waitFor(
      () => {
        const latestRequest = queryURL.mock.calls.map(([url]) => url).findLast((url) => url.includes("text=needle"))
        expect(latestRequest).toContain("author=author-1")
        expect(latestRequest).toContain("gameversions[]=1200")
        expect(latestRequest).toContain("tagids[]=tag-magic")
        expect(latestRequest).toContain("orderby=downloads")
        expect(latestRequest).toContain("orderdirection=asc")
      },
      { timeout: 3000 }
    )

    expect((screen.getByPlaceholderText("Text") as HTMLInputElement).value).toBe("needle")
    expect((screen.getByPlaceholderText("Author") as HTMLInputElement).value).toBe("Author One")
    expect(screen.getByRole("button", { name: /1\.20\.0/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /magic/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Server" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Installed" })).toBeTruthy()
    expect(screen.getByTitle("Show favorite Mods only").getAttribute("aria-pressed")).toBe("true")

    const scrollContainer = document.querySelector("div.overflow-y-scroll") as HTMLDivElement
    scrollContainer.scrollTop = 500
    fireEvent.scroll(scrollContainer)
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Mod \d+, Installed$/ })).toHaveLength(55))

    await user.click(screen.getByRole("button", { name: "Mod 100, Installed" }))
    await screen.findByText("List of versions of the Mod 100 Mod")
    await user.click(screen.getByRole("link", { name: "Mods" }))

    await screen.findByText("Mod 100", {}, { timeout: 3000 })
    const restoredContainer = document.querySelector("div.overflow-y-scroll") as HTMLDivElement
    expect((screen.getByPlaceholderText("Text") as HTMLInputElement).value).toBe("needle")
    expect((screen.getByPlaceholderText("Author") as HTMLInputElement).value).toBe("Author One")
    expect(screen.getByRole("button", { name: /1\.20\.0/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /magic/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Server" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Installed" })).toBeTruthy()
    expect(screen.getByTitle("Show favorite Mods only").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getAllByRole("button", { name: /^Mod \d+, Installed$/ })).toHaveLength(55)
    expect(restoredContainer.scrollTop).toBe(500)
  }, 180_000)

  it("resets the rendered scroll position and browse snapshot when a filter or reload changes the list", async () => {
    const user = userEvent.setup()
    const browseMods = Array.from({ length: 60 }, (_, index) => ({
      modid: 100 + index,
      assetid: 100 + index,
      name: `Mod ${100 + index}`,
      summary: "A browse regression fixture.",
      modidstrs: [`mod-${100 + index}`],
      author: "Someone",
      downloads: 100 - index,
      follows: 200 - index,
      comments: 10,
      side: "server",
      logo: "",
      tags: []
    }))

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ favMods: browseMods.map((mod) => mod.modid) }))
      },
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify({ statuscode: "200", mods: browseMods })
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    installClampedScrollModel()
    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    await screen.findByText("Mod 100", {}, { timeout: 3000 })
    const scrollContainer = document.querySelector("div.overflow-y-scroll") as HTMLDivElement
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 100 })
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => 200 + scrollContainer.querySelectorAll("li").length * 10
    })
    vi.spyOn(Element.prototype, "scrollTo").mockImplementation(function (this: Element, x: number, y: number): void {
      const scrollTarget = x as number | ScrollToOptions
      const top = typeof scrollTarget === "number" ? y : scrollTarget.top
      if (top !== undefined) this.scrollTop = Math.min(Math.max(top, 0), Math.max(0, this.scrollHeight - this.clientHeight))
    })

    const scrollDown = async (): Promise<void> => {
      scrollContainer.scrollTop = 500
      fireEvent.scroll(scrollContainer)
      await waitFor(() => expect(screen.getAllByRole("button", { name: /^Mod \d+/ })).toHaveLength(55))
      expect(getModsBrowseState()).toMatchObject({ visibleMods: 55, scrollTop: 500 })
    }

    await scrollDown()
    fireEvent.change(screen.getByPlaceholderText("Text"), { target: { value: "needle" } })
    expect(scrollContainer.scrollTop).toBe(0)
    expect(getModsBrowseState()).toMatchObject({ visibleMods: DEFAULT_LOADED_MODS, scrollTop: 0 })

    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Mod \d+/ })).toHaveLength(DEFAULT_LOADED_MODS))
    await scrollDown()
    await user.click(screen.getByTitle("Show favorite Mods only"))
    expect(scrollContainer.scrollTop).toBe(0)
    expect(getModsBrowseState()).toMatchObject({ visibleMods: DEFAULT_LOADED_MODS, scrollTop: 0 })

    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Mod \d+/ })).toHaveLength(DEFAULT_LOADED_MODS))
    await scrollDown()
    await user.click(screen.getByTitle("Reload"))
    expect(scrollContainer.scrollTop).toBe(0)
    expect(getModsBrowseState()).toMatchObject({ visibleMods: DEFAULT_LOADED_MODS, scrollTop: 0 })
  }, 30_000)
})
