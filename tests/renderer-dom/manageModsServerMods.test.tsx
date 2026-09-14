import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageMods from "@renderer/features/installations/pages/ManageMods"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI, type WindowApiOverrides } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The Mods a server downloaded, on Manage Mods (#459).
 *
 * The rows that must never be dropped for time are the two that pin server Mods out of the
 * Installation's Mod count and out of the Update all selection: nothing in the type system enforces
 * either, and "Update all never touches a server's Mods" is the whole safety story of the feature.
 */

const INSTALLATION_PATH = "/games/a"
const SERVER_FOLDER = "/games/a/ModsByServer/My Test Server"
const OTHER_SERVER_FOLDER = "/games/a/ModsByServer/192.168.1.10"
const SEARCH_PLACEHOLDER = "Search by name, id or author"
const GROUP_TOGGLE = "Show the Mods this server downloaded"
const REMOVE_TITLE = "Remove the Mods this server downloaded"
const SAVE_TITLE = "Save this set as a modpack file you can install into your own Mods later"

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: INSTALLATION_PATH,
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
    _modsCount: 0,
    ...overrides
  }
}

/** The Installation's own Mods folder: one Mod, and nothing to do with any server. */
function ownMods(): InstalledModsScan {
  return { mods: [{ name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: "/games/a/Mods/alpha-1.0.0.zip", enabled: true, authors: ["Ann"] }], errors: [] }
}

function serverGroups(): ServerModsScan {
  return {
    groups: [
      {
        server: "192.168.1.10",
        path: OTHER_SERVER_FOLDER,
        mods: [{ name: "Zeta Mod", modid: "zeta", version: "9.0.0", path: `${OTHER_SERVER_FOLDER}/zeta-9.0.0.zip`, enabled: true, authors: ["Zoe"] }],
        unreadable: 0
      },
      {
        server: "My Test Server",
        path: SERVER_FOLDER,
        mods: [
          { name: "Gamma Mod", modid: "gamma", version: "3.0.0", path: `${SERVER_FOLDER}/gamma-3.0.0.zip`, enabled: true, authors: ["Cal"] },
          { name: "Omega Mod", modid: "omega", version: "4.0.0", path: `${SERVER_FOLDER}/omega-4.0.0.zip`, enabled: true, authors: ["Cal"] }
        ],
        unreadable: 1
      }
    ]
  }
}

function renderManageMods(overrides: WindowApiOverrides = {}): MockedBridgeAPI {
  const api = installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    // No ModDB lookups for a server group by design, and this file never asserts on the ones the
    // Installation's own Mods make: an empty listing answers both without a network fixture.
    netManager: { queryURL: vi.fn(async () => JSON.stringify({ statuscode: "200", mods: [] })) },
    ...overrides,
    modsManager: { getInstalledMods: vi.fn(async () => ownMods()), getServerMods: vi.fn(async () => serverGroups()), ...overrides.modsManager }
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

  return api
}

/** The header button of one server's group, once the scan has landed. */
function groupHeader(server: string): Promise<HTMLElement> {
  return waitFor(() => {
    const header = screen.getAllByTitle(GROUP_TOGGLE).find((button) => button.textContent?.includes(server))
    if (!header) throw new Error(`no group header for ${server}`)
    return header
  })
}

describe("Manage Mods: the Mods a server downloaded", () => {
  it("does not remove a server folder while an installation backup is active", async () => {
    const api = renderManageMods({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation({ _backuping: true })] })) },
      pathsManager: { deletePath: vi.fn(async () => true) }
    })
    const user = userEvent.setup()

    const header = await groupHeader("My Test Server")
    await user.click(within(header.parentElement!).getByTitle(REMOVE_TITLE))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByTitle("Delete"))

    expect(vi.mocked(api.pathsManager.deletePath)).not.toHaveBeenCalled()
  })

  it("shows one group per server, collapsed, with the count and the sentence that explains them", async () => {
    renderManageMods()

    expect(await screen.findByText("Mods from servers")).toBeTruthy()

    const header = await groupHeader("My Test Server")
    expect(header.getAttribute("aria-expanded")).toBe("false")
    expect(header.textContent).toContain("From server: My Test Server")
    expect(header.textContent).toContain("2 Mods")

    expect(screen.getAllByText(/The game downloaded these Mods to play on this server/).length).toBe(2)
    expect(screen.getByText("1 archive could not be read")).toBeTruthy()

    // Collapsed means the rows are not there at all, not merely hidden.
    expect(screen.queryByText("Gamma Mod")).toBeNull()
  })

  it("shows the rows when the group is opened, and offers no control on any of them", async () => {
    renderManageMods()
    const user = userEvent.setup()

    const header = await groupHeader("My Test Server")
    await user.click(header)

    expect(header.getAttribute("aria-expanded")).toBe("true")
    const row = (await screen.findByText("Gamma Mod")).closest("li")
    expect(row).toBeTruthy()
    expect(within(row!).getByText("From a server")).toBeTruthy()
    expect(within(row!).getByText("v3.0.0")).toBeTruthy()

    // No checkbox, no enable, no suspend, no update, no delete, no ModDB link.
    expect(within(row!).queryAllByRole("button").length).toBe(0)
    expect(within(row!).queryAllByRole("checkbox").length).toBe(0)
    // And nothing about a server Mod says whether the game is loading it: it only does while the
    // player is connected to that server, so an on/off badge would be a lie.
    expect(within(row!).queryByText("DISABLED")).toBeNull()
  })

  it("keeps a server's Mods out of the Installation's Mod count", async () => {
    const api = renderManageMods()

    await groupHeader("My Test Server")

    // One own Mod, three server Mods on screen. The count the card shows is the folder the buttons
    // on this page actually write to, and that is the Mods folder alone.
    await waitFor(() => {
      const saves = vi.mocked(api.configManager.saveConfig).mock.calls
      const counts = saves.map((call) => call[0].installations[0]?._modsCount)
      expect(counts.filter((count) => count !== undefined)).toContain(1)
      expect(counts).not.toContain(4)
    })
  })

  it("keeps a server's Mods out of the Update all selection", async () => {
    renderManageMods()
    const user = userEvent.setup()

    const header = await groupHeader("My Test Server")
    await user.click(header)
    await screen.findByText("Gamma Mod")

    // The selection bar counts the rows Update all and the batch act on. Only the Mods folder's own.
    const selectAll = await screen.findByRole("checkbox", { name: "Select every Mod shown" })
    await user.click(selectAll)

    // The Mods folder's one row, plus Select all itself. The three server rows have no checkbox at all.
    expect(screen.getAllByRole("checkbox", { checked: true }).length).toBe(2)
    expect(screen.getByText("1 selected")).toBeTruthy()
  })

  it("narrows an open group with the page's search field", async () => {
    renderManageMods()
    const user = userEvent.setup()

    const header = await groupHeader("My Test Server")
    await user.click(header)
    await screen.findByText("Gamma Mod")

    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "omega")

    await waitFor(() => expect(screen.queryByText("Gamma Mod")).toBeNull())
    expect(screen.getByText("Omega Mod")).toBeTruthy()
  })

  it("removes exactly the folder the host named, after the confirmation, and rescans", async () => {
    const api = renderManageMods({ pathsManager: { deletePath: vi.fn(async () => true) } })
    const user = userEvent.setup()

    const header = await groupHeader("My Test Server")
    const actions = header.parentElement!
    await user.click(within(actions).getByTitle(REMOVE_TITLE))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/This deletes 2 Mods the game downloaded for My Test Server/)).toBeTruthy()
    await user.click(within(dialog).getByTitle("Delete"))

    await waitFor(() => expect(vi.mocked(api.pathsManager.deletePath).mock.calls).toEqual([[SERVER_FOLDER]]))
    // A removal is only true once the page has looked again: the first scan is the mount, the second
    // is this.
    await waitFor(() => expect(vi.mocked(api.modsManager.getServerMods).mock.calls.length).toBeGreaterThan(1))
  })

  it("deletes nothing when the confirmation is cancelled", async () => {
    const api = renderManageMods({ pathsManager: { deletePath: vi.fn(async () => true) } })
    const user = userEvent.setup()

    const header = await groupHeader("My Test Server")
    await user.click(within(header.parentElement!).getByTitle(REMOVE_TITLE))

    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByTitle("Cancel"))

    await waitFor(() => expect(screen.queryByText(/This deletes 2 Mods/)).toBeNull())
    expect(vi.mocked(api.pathsManager.deletePath).mock.calls.length).toBe(0)
  })

  it("saves one server's set as a modpack named after that server", async () => {
    const api = renderManageMods({ modsManager: { exportModpack: vi.fn(async () => ({ success: true })) } })
    const user = userEvent.setup()

    const header = await groupHeader("My Test Server")
    await user.click(within(header.parentElement!).getByTitle(SAVE_TITLE))

    await waitFor(() => expect(vi.mocked(api.modsManager.exportModpack).mock.calls.length).toBe(1))
    const manifest = vi.mocked(api.modsManager.exportModpack).mock.calls[0]![0]
    expect(manifest.name).toBe("Install A (My Test Server)")
    expect(manifest.mods.map((mod) => mod.modid)).toEqual(["gamma", "omega"])
  })

  it("reaches the header and both actions from the keyboard", async () => {
    renderManageMods()
    const user = userEvent.setup()

    const header = await groupHeader("192.168.1.10")
    header.focus()
    expect(document.activeElement).toBe(header)

    await user.keyboard("{Enter}")
    await waitFor(() => expect(header.getAttribute("aria-expanded")).toBe("true"))

    await user.tab()
    expect(document.activeElement).toBe(within(header.parentElement!).getByTitle(SAVE_TITLE))
    await user.tab()
    expect(document.activeElement).toBe(within(header.parentElement!).getByTitle(REMOVE_TITLE))
  })

  // The rows the filter reaches are the ones a collapsed group does not render, so without the
  // header count a search whose only hit lives in a closed group marks nothing at all.
  it("counts what the search left against the total, in the open group and the closed one", async () => {
    renderManageMods()
    const user = userEvent.setup()

    const header = await groupHeader("My Test Server")
    await user.click(header)
    await screen.findByText("Gamma Mod")

    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "zeta")

    // The open group has nothing left, and says so rather than still reading "2 Mods".
    await waitFor(() => expect((screen.getAllByTitle(GROUP_TOGGLE).find((button) => button.textContent?.includes("My Test Server")) as HTMLElement).textContent).toContain("0 of 2 Mods"))
    // The match itself is in the group that is closed, which is the only thing marking it.
    expect((await groupHeader("192.168.1.10")).textContent).toContain("1 of 1 Mods")
  })

  it("rescans the server folders when the page is reloaded", async () => {
    const api = renderManageMods()
    const user = userEvent.setup()

    await groupHeader("My Test Server")
    const scans = vi.mocked(api.modsManager.getServerMods).mock.calls.length

    await user.click(screen.getByTitle("Reload"))

    await waitFor(() => expect(vi.mocked(api.modsManager.getServerMods).mock.calls.length).toBeGreaterThan(scans))
  })

  // The player is here looking for the disk space the Mod list does not explain. An empty page
  // answers "there is nothing there", which is the one wrong answer.
  it("says the folder could not be read rather than showing nothing at all", async () => {
    renderManageMods({ modsManager: { getServerMods: vi.fn(async () => ({ groups: [], unreadable: true as const })) } })

    expect(await screen.findByText(/the launcher could not read it/)).toBeTruthy()
    expect(screen.getByText("Mods from servers")).toBeTruthy()
  })

  it("keeps a server folder it could not open, with the button that clears it", async () => {
    const locked: ServerModsScan = { groups: [{ server: "Locked Server", path: "/games/a/ModsByServer/Locked Server", mods: [], unreadable: 0, unlistable: true }] }
    renderManageMods({ modsManager: { getServerMods: vi.fn(async () => locked) } })

    const header = await groupHeader("Locked Server")
    expect(screen.getByText(/This folder could not be read/)).toBeTruthy()

    const user = userEvent.setup()
    await user.click(within(header.parentElement!).getByTitle(REMOVE_TITLE))

    // Nothing was read from that folder, so the dialog has no count to state and does not invent one.
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/This deletes the whole folder the game downloaded for Locked Server/)).toBeTruthy()
    expect(within(dialog).queryByText(/This deletes 0 Mods/)).toBeNull()
  })

  it("shows nothing at all when the game has downloaded no server Mods", async () => {
    renderManageMods({ modsManager: { getServerMods: vi.fn(async () => ({ groups: [] })) } })

    await screen.findByText("Alpha Mod")
    expect(screen.queryByText("Mods from servers")).toBeNull()
    expect(screen.queryAllByTitle(GROUP_TOGGLE).length).toBe(0)
  })

  it("says so when a cap stopped the scan short", async () => {
    renderManageMods({ modsManager: { getServerMods: vi.fn(async () => ({ ...serverGroups(), truncated: true as const })) } })

    expect(await screen.findByText(/This Installation holds more server Mods than the launcher shows/)).toBeTruthy()
  })

  // A ModsByServer folder sitting behind a symbolic link is refused by the deletion policy, which is
  // a real setup on a linked data folder. The player has to be told, and not blamed.
  it("says so when the folder could not be removed, and leaves the group where it is", async () => {
    renderManageMods({ pathsManager: { deletePath: vi.fn(async () => false) } })
    const user = userEvent.setup()

    const header = await groupHeader("My Test Server")
    await user.click(within(header.parentElement!).getByTitle(REMOVE_TITLE))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByTitle("Delete"))

    expect(await screen.findByText("Those Mods couldn't be removed. The log has the details.")).toBeTruthy()
    expect((await groupHeader("My Test Server")).textContent).toContain("2 Mods")
  })

  it("shows no region at all when the scan itself fails", async () => {
    renderManageMods({ modsManager: { getServerMods: vi.fn(async () => Promise.reject(new Error("no"))) } })

    await screen.findByText("Alpha Mod")
    expect(screen.queryByText("Mods from servers")).toBeNull()
  })
})
