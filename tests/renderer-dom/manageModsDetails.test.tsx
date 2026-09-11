import { describe, expect, it, vi } from "vitest"
import { act, screen, waitFor, within } from "@testing-library/react"
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
const DELTA_PATH = "/games/a/Mods/delta-4.0.0.zip"
const ALPHA_COPY_PATH = "/games/a/Mods/alpha-copy-1.0.1.zip"
const SEARCH_PLACEHOLDER = "Search by name, id or author"
const DISABLE_TITLE = "Disable this Mod: it stays installed, Vintage Story just won't load it"
const ENABLE_TITLE = "Enable this Mod: Vintage Story will load it again"
const CLOSE_DETAILS = "Close the details"
const NOT_ON_MODDB = "This Mod isn't on the ModDB. It's most likely a local or external build, so only what its own file says is shown."
const LOAD_FAILED = "The ModDB couldn't be reached, so only what the Mod's own file says is shown."
const LOADING = "Looking this Mod up on the ModDB."
const NOT_LISTED = "This version isn't listed on the ModDB."

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

function aModScan(): { mods: InstalledModType[]; errors: ErrorInstalledModType[] } {
  return {
    mods: [
      { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: ALPHA_PATH, enabled: true, description: "The first one.", authors: ["Ann"], contributors: ["Cora"], _image: "alpha.png" },
      { name: "Beta Mod", modid: "beta", version: "2.0.0", path: BETA_PATH, enabled: true, description: "The second one.", side: "Server", authors: ["Bob"], contributors: [] },
      // The game's own spelling of the everywhere side, which the panel names in its own words.
      { name: "Gamma Mod", modid: "gamma", version: "3.0.0", path: GAMMA_PATH, enabled: true, side: "Universal", authors: ["Cal"], contributors: [] },
      // Its id shares nothing with its name, and the ModDB answers 404 for it.
      { name: "Delta Mod", modid: "quirkid", version: "4.0.0", path: DELTA_PATH, enabled: true, description: "Delta's own words.", side: "Client", authors: ["Dee"], contributors: [] }
    ],
    errors: []
  }
}

function duplicateModScan(): { mods: InstalledModType[]; errors: ErrorInstalledModType[] } {
  return {
    mods: [
      { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: ALPHA_PATH, enabled: true, authors: [] },
      { name: "Alpha Mod copy", modid: "alpha", version: "1.0.1", path: ALPHA_COPY_PATH, enabled: true, authors: [] }
    ],
    errors: []
  }
}

function aRelease(modversion: string, tags: string[], created = ""): Record<string, unknown> {
  return { releaseid: 1, mainfile: `https://mods.example/${modversion}.zip`, filename: `${modversion}.zip`, fileid: 1, downloads: 0, tags, modidstr: "x", modversion, created, changelog: "" }
}

// Newest first, as the ModDB serves them. The newer release is tagged for another series only.
const ALPHA_DETAIL = {
  modid: 1,
  assetid: 101,
  name: "Alpha Mod",
  author: "Ann of the ModDB",
  downloads: 1234,
  follows: 56,
  tags: ["Utility"],
  text: "<p>Alpha tidies your inventory.</p><p>It also sorts chests.</p>",
  releases: [aRelease("1.1.0", ["1.19.0"], "2024-05-01 10:00:00"), aRelease("1.0.0", ["1.20.0"])]
}
// Its only release is newer than the installed 2.0.0, which the ModDB does not list.
const BETA_DETAIL = { modid: 2, assetid: 102, name: "Beta Mod", author: "Bob", releases: [aRelease("2.1.0", ["1.20.0"])] }
const GAMMA_DETAIL = { modid: 3, assetid: 103, name: "Gamma Mod", author: "Cal of the ModDB", releases: [aRelease("3.0.0", ["1.20.0"])] }
const DETAILS: Record<string, unknown> = { alpha: ALPHA_DETAIL, beta: BETA_DETAIL, gamma: GAMMA_DETAIL }

function aDetail(mod: unknown): string {
  return JSON.stringify({ statuscode: "200", mod })
}

/** Answers `/api/mod/{id}` from `details`, and a clean 404 for any id it does not hold. */
function moddbWith(details: Record<string, unknown>): (url: string) => Promise<string> {
  return (url) => {
    const detail = details[url.split("/").pop() ?? ""]
    return Promise.resolve(detail ? aDetail(detail) : JSON.stringify({ statuscode: "404" }))
  }
}

function renderManageMods(overrides: WindowApiOverrides = {}): void {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    netManager: { queryURL: vi.fn(moddbWith(DETAILS)) },
    ...overrides,
    modsManager: { getInstalledMods: vi.fn(async () => aModScan()), ...overrides.modsManager }
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

function detailsButtonFor(name: string): Promise<HTMLElement> {
  return screen.findByRole("button", { name: `Show the details of ${name}` }, { timeout: 3000 })
}

function rowOf(detailsButton: HTMLElement): HTMLElement {
  return detailsButton.closest("li") as HTMLElement
}

function detailsPanel(): HTMLElement | null {
  return document.querySelector("aside")
}

describe("ManageMods details panel", () => {
  it("opens the clicked Mod's details beside the list and marks only that row pressed", async () => {
    const user = userEvent.setup()
    renderManageMods()

    const alpha = await detailsButtonFor("Alpha Mod")
    const beta = await detailsButtonFor("Beta Mod")
    expect(detailsPanel()).toBeNull()
    expect(alpha.getAttribute("aria-pressed")).toBe("false")

    await user.click(alpha)

    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    expect(within(aside).getByText("Ann of the ModDB")).toBeTruthy()
    expect(within(aside).getByText("1,234")).toBeTruthy()
    expect(within(aside).getByText("56")).toBeTruthy()
    expect(within(aside).getByText("Utility")).toBeTruthy()
    expect(within(aside).getByText("Alpha tidies your inventory.")).toBeTruthy()
    expect(within(aside).getByText("It also sorts chests.")).toBeTruthy()
    // What the file itself says is there too, but its description only stands in for a missing one.
    expect(within(aside).getByText("Ann")).toBeTruthy()
    expect(within(aside).getByText("Cora")).toBeTruthy()
    expect(within(aside).queryByText("The first one.")).toBeNull()
    // The cached logo, never the remote one.
    expect(aside.querySelector("img")?.getAttribute("src")).toBe("cachemodimg:alpha.png")

    expect(alpha.getAttribute("aria-pressed")).toBe("true")
    expect(beta.getAttribute("aria-pressed")).toBe("false")

    // Another row switches the panel over, and focus follows it.
    await user.click(beta)

    const betaAside = await screen.findByRole("complementary", { name: "Beta Mod" })
    expect(within(betaAside).getByText("Server")).toBeTruthy()
    expect(alpha.getAttribute("aria-pressed")).toBe("false")
    expect(beta.getAttribute("aria-pressed")).toBe("true")
    await waitFor(() => expect(document.activeElement).toBe(within(betaAside).getByRole("heading", { name: "Beta Mod" })))
  })

  it("tells two files of one mod apart", async () => {
    const user = userEvent.setup()
    renderManageMods({ modsManager: { getInstalledMods: vi.fn(async () => duplicateModScan()) } })

    const original = await detailsButtonFor("Alpha Mod")
    const copy = await detailsButtonFor("Alpha Mod copy")

    await user.click(copy)

    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    expect(within(aside).getByText("v1.0.1")).toBeTruthy()
    expect(within(aside).queryByText("v1.0.0")).toBeNull()
    expect(copy.getAttribute("aria-pressed")).toBe("true")
    expect(original.getAttribute("aria-pressed")).toBe("false")
  })

  it("shows the ModDB description as text and never as markup", async () => {
    const user = userEvent.setup()
    const hostile = '<p>Safe words</p><img src="x" onerror="window.__pwned=1"><a href="https://evil.example">link</a><script>window.__pwned=1</script>&lt;b&gt;'
    renderManageMods({ netManager: { queryURL: vi.fn(moddbWith({ ...DETAILS, alpha: { ...ALPHA_DETAIL, text: hostile } })) } })

    await user.click(await detailsButtonFor("Alpha Mod"))

    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    expect(within(aside).getByText("Safe words")).toBeTruthy()
    expect(within(aside).getByText("link<b>")).toBeTruthy()
    expect(aside.querySelector('img[src="x"], a, b, script, iframe, style')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it("gives the installed release's verdict in words for this installation", async () => {
    const user = userEvent.setup()
    renderManageMods()

    await user.click(await detailsButtonFor("Alpha Mod"))

    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    const installed = within(aside).getByRole("region", { name: "Installed version" })
    expect(within(installed).getByText("Tagged")).toBeTruthy()
    expect(within(installed).getByText("1.20.0")).toBeTruthy()

    const rows = within(within(aside).getByRole("list", { name: "Releases" })).getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText("1.1.0")).toBeTruthy()
    expect(within(rows[0] as HTMLElement).getByText("Untagged")).toBeTruthy()
    expect(within(rows[0] as HTMLElement).queryByText("Installed")).toBeNull()
    expect(within(rows[0] as HTMLElement).getByText("5/1/2024")).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText("1.0.0")).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText("Tagged")).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText("Installed")).toBeTruthy()
    // The second release carries no date, and none is made up for it.
    expect(aside.textContent).not.toContain("Invalid Date")

    // Beta's installed 2.0.0 is not on the ModDB at all, so there is no verdict to give for it.
    await user.click(await detailsButtonFor("Beta Mod"))

    const betaInstalled = within(await screen.findByRole("complementary", { name: "Beta Mod" })).getByRole("region", { name: "Installed version" })
    expect(within(betaInstalled).getByText(NOT_LISTED)).toBeTruthy()
    expect(within(betaInstalled).queryByText(/Tagged|Likely|Untagged/)).toBeNull()
  })

  it("says a Mod is not on the ModDB when the ModDB answers 404 and keeps what its file says", async () => {
    const user = userEvent.setup()
    renderManageMods()

    await user.click(await detailsButtonFor("Delta Mod"))

    const aside = await screen.findByRole("complementary", { name: "Delta Mod" })
    expect(await within(aside).findByText(NOT_ON_MODDB)).toBeTruthy()
    expect(within(aside).getByText("Dee")).toBeTruthy()
    expect(within(aside).getByText("Client")).toBeTruthy()
    expect(within(aside).getByText("Delta's own words.")).toBeTruthy()
    expect(within(aside).queryByText(LOAD_FAILED)).toBeNull()
    expect(within(aside).queryByRole("button", { name: "Reload" })).toBeNull()
    expect(within(aside).queryByRole("button", { name: "Open on the ModDB!" })).toBeNull()
  })

  it("offers a retry when the ModDB could not be reached, then shows the details", async () => {
    const user = userEvent.setup()
    let reachable = false
    let answer: (text: string) => void = () => {}
    const queryURL = vi.fn((url: string): Promise<string> => {
      if (!url.endsWith("/mod/gamma")) return moddbWith(DETAILS)(url)
      if (!reachable) return Promise.reject(new Error("offline"))
      return new Promise<string>((resolve) => (answer = resolve))
    })
    renderManageMods({ netManager: { queryURL } })

    await user.click(await detailsButtonFor("Gamma Mod"))

    const aside = await screen.findByRole("complementary", { name: "Gamma Mod" })
    expect(await within(aside).findByText(LOAD_FAILED)).toBeTruthy()
    expect(within(aside).queryByText(NOT_ON_MODDB)).toBeNull()

    reachable = true
    await user.click(within(aside).getByRole("button", { name: "Reload" }))

    expect(await within(aside).findByText(LOADING)).toBeTruthy()
    await act(async () => answer(aDetail(GAMMA_DETAIL)))

    expect(await within(aside).findByText("Cal of the ModDB")).toBeTruthy()
    expect(within(aside).queryByText(LOAD_FAILED)).toBeNull()
    expect(within(aside).queryByText(LOADING)).toBeNull()
  })

  it("starts each lookup afresh when the panel moves on to another Mod", async () => {
    const user = userEvent.setup()
    let gammaCalls = 0
    const queryURL = vi.fn((url: string): Promise<string> => {
      if (!url.endsWith("/mod/gamma")) return moddbWith(DETAILS)(url)
      gammaCalls++
      // The scan's lookup fails, so the panel runs its own, which is still out when this test ends.
      return gammaCalls === 1 ? Promise.reject(new Error("offline")) : new Promise<string>(() => {})
    })
    renderManageMods({ netManager: { queryURL } })

    await user.click(await detailsButtonFor("Delta Mod"))
    expect(await within(await screen.findByRole("complementary", { name: "Delta Mod" })).findByText(NOT_ON_MODDB)).toBeTruthy()

    await user.click(await detailsButtonFor("Gamma Mod"))

    const aside = await screen.findByRole("complementary", { name: "Gamma Mod" })
    expect(await within(aside).findByText(LOADING)).toBeTruthy()
    expect(within(aside).queryByText(NOT_ON_MODDB)).toBeNull()
    expect(within(aside).getByText("Both")).toBeTruthy()
  })

  it("makes no ModDB request when the scan already has the detail", async () => {
    const user = userEvent.setup()
    const queryURL = vi.fn(moddbWith(DETAILS))
    renderManageMods({ netManager: { queryURL } })

    await user.click(await detailsButtonFor("Alpha Mod"))

    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    expect(within(aside).getByText("Ann of the ModDB")).toBeTruthy()
    await act(async () => {})
    expect(queryURL.mock.calls.filter(([url]) => url.endsWith("/mod/alpha"))).toHaveLength(1)
  })

  it("moves focus into the panel, and Escape gives it back to the row", async () => {
    const user = userEvent.setup()
    renderManageMods()

    const alpha = await detailsButtonFor("Alpha Mod")
    expect(alpha.tabIndex).toBe(0)

    act(() => alpha.focus())
    await user.keyboard("{Enter}")

    let aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    await waitFor(() => expect(document.activeElement).toBe(within(aside).getByRole("heading", { name: "Alpha Mod" })))

    await user.keyboard("{Escape}")

    expect(detailsPanel()).toBeNull()
    expect(document.activeElement).toBe(alpha)

    // Space opens it too, and Escape works from anywhere inside the panel, not only its heading.
    await user.keyboard(" ")
    aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    await waitFor(() => expect(document.activeElement).toBe(within(aside).getByRole("heading", { name: "Alpha Mod" })))
    await user.tab()
    expect(document.activeElement).toBe(within(aside).getByRole("button", { name: "Close the details" }))

    await user.keyboard("{Escape}")

    expect(detailsPanel()).toBeNull()
    expect(document.activeElement).toBe(alpha)
  })

  it("closes from the Close button and from the pressed row itself", async () => {
    const user = userEvent.setup()
    renderManageMods()

    const alpha = await detailsButtonFor("Alpha Mod")
    await user.click(alpha)
    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })

    await user.click(within(aside).getByRole("button", { name: "Close the details" }))

    expect(detailsPanel()).toBeNull()
    expect(document.activeElement).toBe(alpha)
    expect(alpha.getAttribute("aria-pressed")).toBe("false")

    await user.click(alpha)
    expect(await screen.findByRole("complementary", { name: "Alpha Mod" })).toBeTruthy()

    await user.click(alpha)

    expect(detailsPanel()).toBeNull()
    expect(alpha.getAttribute("aria-pressed")).toBe("false")
  })

  it("stays on the Mod through a disable and an enable, and still closes from its renamed row", async () => {
    const user = userEvent.setup()
    let disabled = false
    const getInstalledMods = vi.fn(async () => {
      const scan = aModScan()
      if (disabled) scan.mods[0] = { ...(scan.mods[0] as InstalledModType), path: `${ALPHA_PATH}.disabled`, enabled: false }
      return scan
    })
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string, enabled: boolean) => {
      disabled = !enabled
      return { ok: true, path: enabled ? path.slice(0, -".disabled".length) : `${path}.disabled` }
    })
    renderManageMods({ modsManager: { getInstalledMods, setModEnabled } })

    const alpha = await detailsButtonFor("Alpha Mod")
    await user.click(alpha)
    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    expect(within(aside).queryByText("Disabled")).toBeNull()

    await user.click(within(rowOf(alpha)).getByTitle(DISABLE_TITLE))

    await waitFor(() => expect(setModEnabled).toHaveBeenCalledWith(ALPHA_PATH, false))
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Alpha Mod" })).getByText("Disabled")).toBeTruthy())
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "Alpha Mod" }))
    // The row describing the renamed file is the pressed one now.
    const disabledRow = await detailsButtonFor("Alpha Mod")
    expect(disabledRow.getAttribute("aria-pressed")).toBe("true")

    // The panel was opened on the old name, and closing it hands focus to the row holding the new one.
    await user.click(within(screen.getByRole("complementary", { name: "Alpha Mod" })).getByRole("button", { name: CLOSE_DETAILS }))
    expect(detailsPanel()).toBeNull()
    expect(document.activeElement).toBe(disabledRow)

    // Opened on the disabled name this time, then renamed back by an enable.
    await user.click(disabledRow)
    expect(await screen.findByRole("complementary", { name: "Alpha Mod" })).toBeTruthy()
    await user.click(within(rowOf(disabledRow)).getByTitle(ENABLE_TITLE))

    await waitFor(() => expect(setModEnabled).toHaveBeenCalledWith(`${ALPHA_PATH}.disabled`, true))
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Alpha Mod" })).queryByText("Disabled")).toBeNull())

    // The pressed row closes the panel, whatever name the panel was opened on.
    const enabledRow = await detailsButtonFor("Alpha Mod")
    expect(enabledRow.getAttribute("aria-pressed")).toBe("true")
    await user.click(enabledRow)

    expect(detailsPanel()).toBeNull()
    expect(enabledRow.getAttribute("aria-pressed")).toBe("false")
  })

  it("closes the panel when the Mod it shows is deleted", async () => {
    const user = userEvent.setup()
    let deleted = false
    const getInstalledMods = vi.fn(async () => {
      const scan = aModScan()
      if (deleted) scan.mods.shift()
      return scan
    })
    const deletePath = vi.fn(async () => {
      deleted = true
      return true
    })
    renderManageMods({ modsManager: { getInstalledMods }, pathsManager: { deletePath } })

    const alpha = await detailsButtonFor("Alpha Mod")
    await user.click(alpha)
    expect(await screen.findByRole("complementary", { name: "Alpha Mod" })).toBeTruthy()

    await user.click(within(rowOf(alpha)).getByTitle("Delete"))
    await user.click(within(await screen.findByRole("dialog")).getByTitle("Delete"))

    await waitFor(() => expect(deletePath).toHaveBeenCalledWith(ALPHA_PATH))
    await waitFor(() => expect(screen.queryByText("The first one.")).toBeNull())
    expect(detailsPanel()).toBeNull()
  })

  // Both halves of a #292 pair are listed, each as its own file, and deleting one leaves the other.
  it.each([
    { shown: "the enabled file", deletedPath: ALPHA_PATH },
    { shown: "the disabled file", deletedPath: `${ALPHA_PATH}.disabled` }
  ])("closes the panel when $shown is deleted instead of moving onto its twin", async ({ deletedPath }) => {
    const user = userEvent.setup()
    let deleted = false
    const getInstalledMods = vi.fn(async () => {
      const scan = aModScan()
      const alpha = scan.mods[0] as InstalledModType
      const pair = [alpha, { ...alpha, path: `${ALPHA_PATH}.disabled`, enabled: false }]
      scan.mods.splice(0, 1, ...pair.filter((mod) => !deleted || mod.path !== deletedPath))
      return scan
    })
    const deletePath = vi.fn(async () => {
      deleted = true
      return true
    })
    renderManageMods({ modsManager: { getInstalledMods }, pathsManager: { deletePath } })

    const rows = await screen.findAllByRole("button", { name: "Show the details of Alpha Mod" }, { timeout: 3000 })
    expect(rows).toHaveLength(2)
    const shown = rows.find((row) => (within(rowOf(row)).queryByText("Disabled") !== null) === deletedPath.endsWith(".disabled")) as HTMLElement
    await user.click(shown)
    expect(await screen.findByRole("complementary", { name: "Alpha Mod" })).toBeTruthy()

    await user.click(within(rowOf(shown)).getByTitle("Delete"))
    await user.click(within(await screen.findByRole("dialog")).getByTitle("Delete"))

    await waitFor(() => expect(deletePath).toHaveBeenCalledWith(deletedPath))
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Show the details of Alpha Mod" })).toHaveLength(1))
    expect(detailsPanel()).toBeNull()
    expect((await detailsButtonFor("Alpha Mod")).getAttribute("aria-pressed")).toBe("false")
  })

  it("forgets a Mod that left the folder, so a file of the same name coming back stays closed", async () => {
    const user = userEvent.setup()
    let present = true
    const getInstalledMods = vi.fn(async () => {
      const scan = aModScan()
      if (!present) scan.mods.shift()
      return scan
    })
    renderManageMods({ modsManager: { getInstalledMods } })

    await user.click(await detailsButtonFor("Alpha Mod"))
    expect(await screen.findByRole("complementary", { name: "Alpha Mod" })).toBeTruthy()

    // Removed behind the page's back, by the player's file manager, and found by a Reload.
    present = false
    await user.click(screen.getByRole("button", { name: "Reload" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show the details of Alpha Mod" })).toBeNull())
    expect(detailsPanel()).toBeNull()

    present = true
    await user.click(screen.getByRole("button", { name: "Reload" }))

    const alpha = await detailsButtonFor("Alpha Mod")
    await act(async () => {})
    expect(detailsPanel()).toBeNull()
    expect(alpha.getAttribute("aria-pressed")).toBe("false")
  })

  it("takes the panel away with the rows while Update all runs, leaving focus where the player is", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn(async () => true)
    const downloadOnPath = vi.fn(() => new Promise<string>(() => {}))
    renderManageMods({ pathsManager: { deletePath, downloadOnPath } })

    await user.click(await detailsButtonFor("Beta Mod"))
    expect(await screen.findByRole("complementary", { name: "Beta Mod" })).toBeTruthy()

    const updateAll = screen.getByText("Update all").closest("button") as HTMLElement
    await user.click(updateAll)

    expect(await screen.findByText("Updating installed Mods!")).toBeTruthy()
    await waitFor(() => expect(downloadOnPath).toHaveBeenCalled())
    expect(detailsPanel()).toBeNull()
    expect(document.activeElement).toBe(updateAll)
  })

  it("hides the panel while the search hides its Mod and brings it back", async () => {
    const user = userEvent.setup()
    renderManageMods()

    await user.click(await detailsButtonFor("Alpha Mod"))
    expect(await screen.findByRole("complementary", { name: "Alpha Mod" })).toBeTruthy()

    const search = screen.getByPlaceholderText(SEARCH_PLACEHOLDER)
    await user.type(search, "beta")

    await waitFor(() => expect(detailsPanel()).toBeNull())

    await user.clear(search)

    expect(await screen.findByRole("complementary", { name: "Alpha Mod" })).toBeTruthy()
    // Coming back does not pull focus out of the field the player is typing in.
    expect(document.activeElement).toBe(search)
  })

  it("opens the ModDB page from the panel through the allowed address", async () => {
    const user = userEvent.setup()
    renderManageMods()

    await user.click(await detailsButtonFor("Alpha Mod"))
    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })

    await user.click(within(aside).getByRole("button", { name: "Open on the ModDB!" }))

    expect(window.api.utils.openOnBrowser).toHaveBeenCalledWith("https://mods.vintagestory.at/show/mod/101")
  })

  it("offers a row's ModDB page only for a Mod the ModDB knows", async () => {
    const user = userEvent.setup()
    renderManageMods()

    // The ModDB answered 404 for Delta, so there is no page to open and no /show/mod/undefined.
    expect(within(rowOf(await detailsButtonFor("Delta Mod"))).queryByTitle("Open on the ModDB!")).toBeNull()

    await user.click(within(rowOf(await detailsButtonFor("Alpha Mod"))).getByTitle("Open on the ModDB!"))

    expect(window.api.utils.openOnBrowser).toHaveBeenCalledWith("https://mods.vintagestory.at/show/mod/101")
  })

  it("renders a detail whose fields came back null instead of taking the page down", async () => {
    const user = userEvent.setup()
    const broken = { ...ALPHA_DETAIL, author: null, text: null, downloads: "12", follows: "x" }
    renderManageMods({ netManager: { queryURL: vi.fn(moddbWith({ ...DETAILS, alpha: broken })) } })

    await user.click(await detailsButtonFor("Alpha Mod"))

    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    expect(within(aside).getByRole("heading", { name: "Alpha Mod" })).toBeTruthy()
    expect(within(aside).queryByText("Author")).toBeNull()
    expect(within(aside).queryByText("Downloads")).toBeNull()
    expect(within(aside).queryByText("Follows")).toBeNull()
    expect(aside.textContent).not.toMatch(/12|NaN/)
    // With no ModDB description left, the file's own one stands in.
    expect(within(aside).getByText("The first one.")).toBeTruthy()
  })

  it("falls back to the file's own description when the ModDB's has no words left once stripped", async () => {
    const user = userEvent.setup()
    renderManageMods({ netManager: { queryURL: vi.fn(moddbWith({ ...DETAILS, alpha: { ...ALPHA_DETAIL, text: '<p><img src="banner.png"></p>' } })) } })

    await user.click(await detailsButtonFor("Alpha Mod"))

    expect(within(await screen.findByRole("complementary", { name: "Alpha Mod" })).getByText("The first one.")).toBeTruthy()
  })

  it("shows the first 200 paragraphs of a description and leaves the rest to the ModDB page", async () => {
    const user = userEvent.setup()
    const text = Array.from({ length: 250 }, (_, index) => `<p>Paragraph ${index + 1}</p>`).join("")
    renderManageMods({ netManager: { queryURL: vi.fn(moddbWith({ ...DETAILS, alpha: { ...ALPHA_DETAIL, text } })) } })

    await user.click(await detailsButtonFor("Alpha Mod"))

    const aside = await screen.findByRole("complementary", { name: "Alpha Mod" })
    expect(within(aside).getByText("Paragraph 200")).toBeTruthy()
    expect(within(aside).queryByText("Paragraph 201")).toBeNull()
  })
})
