import { afterEach, describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { installMockWindowApi, createMockConfig, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"
import { resetModsBrowseState } from "@renderer/features/mods/modsBrowseState"
import { clearQueryCache } from "@renderer/features/mods/hooks/useQueryMods"

const INSTALLATION: InstallationType = {
  id: "install-a",
  name: "Install A",
  icon: "",
  path: "/games/a",
  version: "1.22.7",
  gameVersionId: null,
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

const CANDIDATE: DownloadableModOnListType = {
  modid: 123,
  assetid: 123,
  downloads: 100,
  follows: 5,
  trendingpoints: 10,
  comments: 1,
  name: "Suggestion Candidate",
  summary: "A useful Mod.",
  modidstrs: ["suggestioncandidate"],
  author: "Author",
  urlalias: null,
  side: "client",
  type: "mod",
  logo: "",
  tags: ["Tweak"],
  lastreleased: "2026-09-14"
}

const DETAIL: DownloadableModType = {
  modid: 123,
  assetid: 123,
  name: "Suggestion Candidate",
  urlalias: null,
  homepageurl: null,
  sourcecodeurl: null,
  trendingpoints: 10,
  comments: 1,
  createdat: "2026-01-01",
  tags: ["Tweak"],
  releases: [
    {
      releaseid: 1,
      mainfile: "https://mods.example/suggestioncandidate-1.0.0.zip",
      filename: "suggestioncandidate-1.0.0.zip",
      fileid: 1,
      downloads: 1,
      tags: ["1.22.7"],
      modidstr: "suggestioncandidate",
      modversion: "1.0.0",
      created: "2026-09-14",
      changelog: ""
    }
  ]
}

function mount(consent: boolean | null = null): { api: MockedBridgeAPI; queryURL: ReturnType<typeof vi.fn> } {
  const queryURL = vi.fn(async (url: string): Promise<string> => {
    if (url.endsWith("/api/mods") || url.includes("/api/mods?")) return JSON.stringify({ statuscode: "200", mods: [CANDIDATE] })
    if (url.endsWith("/api/mod/123")) return JSON.stringify({ statuscode: "200", mod: DETAIL })
    return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
  })
  const api = installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: INSTALLATION.id, installations: [INSTALLATION], modSuggestionsConsent: consent }))
    },
    modsManager: { getInstalledMods: vi.fn(async () => ({ mods: [], errors: [] })) },
    netManager: { queryURL }
  })

  renderWithProviders(
    <TaskProvider>
      <Routes>
        <Route path="/mods" element={<ListMods />} />
      </Routes>
    </TaskProvider>,
    { route: "/mods" }
  )
  return { api, queryURL }
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  resetModsBrowseState()
  clearQueryCache()
})

describe("Mod suggestions", () => {
  it("does no suggestion request or card work before the independent opt-in", async () => {
    const { queryURL } = mount()

    await screen.findByRole("button", { name: "Suggestion Candidate, Not installed" }, { timeout: 3000 })
    expect(queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods"))).toHaveLength(0)
    expect(screen.queryByRole("heading", { name: "Suggested for Install A" })).toBeNull()
    expect(screen.getByRole("button", { name: "Turn on Mod suggestions" })).toBeTruthy()
  })

  it("opts in, renders the reason above the grid, refreshes, and persists dismissal", async () => {
    const user = userEvent.setup()
    const { api, queryURL } = mount()

    await screen.findByRole("button", { name: "Turn on Mod suggestions" }, { timeout: 3000 })
    await user.click(screen.getByRole("button", { name: "Turn on Mod suggestions" }))

    const section = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    await within(section).findByText(/Popular|Recently updated|You run this/i)
    await waitFor(() => expect(queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods")).length).toBe(1))
    expect(api.configManager.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ modSuggestionsConsent: true }))

    const beforeRefresh = queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods")).length
    await user.click(within(section).getByRole("button", { name: "Refresh suggestions" }))
    await waitFor(() => expect(queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods")).length).toBe(beforeRefresh + 1))

    await user.click(within(section).getByRole("button", { name: "Dismiss suggestion" }))
    await waitFor(() => expect(screen.queryByRole("region", { name: "Suggested for Install A" })).toBeNull())
    expect(api.configManager.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ dismissedModSuggestions: [123] }))
  }, 15_000)

  it("Add all opens the existing install confirmation without downloading first", async () => {
    const user = userEvent.setup()
    const downloadOnPath = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(async () => "")
    const { api } = mount(true)
    Object.assign(api.pathsManager, { downloadOnPath })

    const section = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    await user.click(within(section).getByRole("button", { name: "Add all suggestions" }))

    const dialog = await screen.findByRole("dialog", { name: "Install Selected Mods" }, { timeout: 3000 })
    expect(within(dialog).getByText("Suggestion Candidate")).toBeTruthy()
    expect(downloadOnPath).not.toHaveBeenCalled()
  }, 15_000)
})
