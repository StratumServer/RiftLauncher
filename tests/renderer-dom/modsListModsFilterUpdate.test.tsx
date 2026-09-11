import { StrictMode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { getModsBrowseState, resetModsBrowseState, updateModsBrowseState } from "@renderer/features/mods/modsBrowseState"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const BROWSE_MODS = {
  statuscode: "200",
  mods: [{ modid: 123, assetid: 123, name: "Better Ruins", summary: "", modidstrs: ["betterruins"], author: "Someone", downloads: 42, follows: 7, comments: 1, side: "both", logo: "", tags: [] }]
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  resetModsBrowseState()
})

/**
 * A filter change resets the browse position in the event that changed it, never from inside a
 * state updater. Updaters run during render, and StrictMode runs them twice, which is how a scroll
 * written from one shows up here: as more resets than the filters the click changed.
 */
describe("ListMods filter updates", () => {
  it("resets the browse position once per filter a click changes, even under StrictMode", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig()) },
      netManager: {
        queryURL: async (url: string) => JSON.stringify(url.includes("/api/mods") ? BROWSE_MODS : { statuscode: "200", authors: [], gameversions: [], tags: [] })
      }
    })
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => {})

    renderWithProviders(
      <StrictMode>
        <TaskProvider>
          <ListMods />
        </TaskProvider>
      </StrictMode>,
      { route: "/mods" }
    )
    await screen.findByText("Better Ruins", {}, { timeout: 3000 })
    const { orderBy } = getModsBrowseState()

    // Picking the active sort key flips its direction: one filter, one reset.
    await user.click(screen.getByTitle("Order"))
    const activeKey = await screen.findByTitle(orderBy === "downloads" ? "Downloads" : "Follows")
    scrollTo.mockClear()
    await user.click(activeKey)
    expect(scrollTo).toHaveBeenCalledTimes(1)

    // Picking another key sets it and puts the direction back to descending: two filters, two resets.
    await user.click(screen.getByTitle("Order"))
    const otherKey = await screen.findByTitle(orderBy === "downloads" ? "Comments" : "Downloads")
    scrollTo.mockClear()
    await user.click(otherKey)
    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    expect(getModsBrowseState()).toMatchObject({ orderBy: orderBy === "downloads" ? "comments" : "downloads", orderByOrder: "desc" })
  }, 20_000)
})

describe("ListMods installed filters", () => {
  const CATALOG = {
    statuscode: "200",
    mods: [
      { modid: 123, assetid: 123, name: "Better Ruins", summary: "", modidstrs: ["betterruins"], author: "Someone", downloads: 42, follows: 7, comments: 1, side: "both", logo: "", tags: [] },
      {
        modid: 456,
        assetid: 456,
        name: "Primitive Survival",
        summary: "",
        modidstrs: ["primitivesurvival"],
        author: "Someone",
        downloads: 41,
        follows: 6,
        comments: 1,
        side: "both",
        logo: "",
        tags: []
      }
    ]
  }

  /** The folder holds Better Ruins under the casing its modinfo uses, which the listing spells in lowercase. */
  function renderWithOneInstalledMod(installedFilter: string): ReturnType<typeof vi.fn> {
    updateModsBrowseState({ installedFilter })
    const getInstalledMods = vi.fn(async () => ({
      mods: [{ name: "Better Ruins", modid: "BetterRuins", version: "1.0.0", path: "/games/a/Mods/betterruins-1.0.0.zip", enabled: true }],
      errors: []
    }))
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            lastUsedInstallation: "install-a",
            installations: [
              {
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
                envVars: ""
              }
            ]
          })
        )
      },
      modsManager: { getInstalledMods },
      netManager: {
        queryURL: async (url: string) => JSON.stringify(url.includes("/api/mods") ? CATALOG : { statuscode: "200", authors: [], gameversions: [], tags: [] })
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )
    return getInstalledMods
  }

  it("keeps only the listings the folder holds under Installed", async () => {
    renderWithOneInstalledMod("installed")

    expect(await screen.findByText("Better Ruins", {}, { timeout: 3000 })).toBeTruthy()
    expect(screen.queryByText("Primitive Survival")).toBeNull()
  })

  it("keeps only the listings the folder lacks under Not installed", async () => {
    const getInstalledMods = renderWithOneInstalledMod("not-installed")

    // The grid first answers before the config has loaded, with no Installation and so nothing
    // installed; the query that counts is the one the folder scan triggers.
    expect(await screen.findByText("Primitive Survival", {}, { timeout: 3000 })).toBeTruthy()
    await waitFor(() => expect(getInstalledMods).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText("Better Ruins")).toBeNull(), { timeout: 3000 })
    expect(screen.getByText("Primitive Survival")).toBeTruthy()
  })
})
