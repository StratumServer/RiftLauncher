import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen, waitFor, within } from "@testing-library/react"
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

const BACKFILL_CANDIDATE: DownloadableModOnListType = {
  ...CANDIDATE,
  modid: 124,
  assetid: 124,
  name: "Backfill Candidate",
  modidstrs: ["backfillcandidate"]
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

function detailFor(candidate: DownloadableModOnListType): DownloadableModType {
  return {
    ...DETAIL,
    modid: candidate.modid,
    assetid: candidate.assetid,
    name: candidate.name,
    releases: [{ ...DETAIL.releases[0]!, modidstr: candidate.modidstrs[0]!, mainfile: `https://mods.example/${candidate.modidstrs[0]}-1.0.0.zip`, filename: `${candidate.modidstrs[0]}-1.0.0.zip` }]
  }
}

const MANY_CANDIDATES = [
  CANDIDATE,
  BACKFILL_CANDIDATE,
  ...Array.from({ length: 5 }, (_, index) => ({ ...CANDIDATE, modid: 125 + index, assetid: 125 + index, name: `Suggestion Candidate ${index + 3}`, modidstrs: [`suggestioncandidate${index + 3}`] }))
]

function mount(consent: boolean | null = null, suggestionCandidates: readonly DownloadableModOnListType[] = [CANDIDATE], folded = false): { api: MockedBridgeAPI; queryURL: ReturnType<typeof vi.fn> } {
  const queryURL = vi.fn(async (url: string): Promise<string> => {
    if (url.endsWith("/api/mods") || url.includes("/api/mods?")) return JSON.stringify({ statuscode: "200", mods: suggestionCandidates })
    const candidate = suggestionCandidates.find(({ modid }) => url.endsWith(`/api/mod/${modid}`))
    if (candidate) return JSON.stringify({ statuscode: "200", mod: detailFor(candidate) })
    return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
  })
  const api = installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: INSTALLATION.id, installations: [INSTALLATION], modSuggestionsConsent: consent, modSuggestionsFolded: folded }))
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

/** The last config the page pushed at the main process. */
function lastSavedConfig(api: MockedBridgeAPI): ConfigType {
  const calls = vi.mocked(api.configManager.saveConfig).mock.calls
  return calls[calls.length - 1]?.[0] as ConfigType
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

  it("dismisses one card locally without rerunning the pipeline and backfills from the ranked pool", async () => {
    const user = userEvent.setup()
    const { queryURL } = mount(null, MANY_CANDIDATES)

    await user.click(await screen.findByRole("button", { name: "Turn on Mod suggestions" }, { timeout: 3000 }))
    const section = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    await within(section).findByRole("button", { name: "Suggestion Candidate 6, Not installed" })
    const catalogRequests = (): typeof queryURL.mock.calls => queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods"))
    const detailRequests = (): typeof queryURL.mock.calls => queryURL.mock.calls.filter(([url]) => url.includes("/api/mod/"))
    await waitFor(() => expect(catalogRequests()).toHaveLength(1))
    const detailsBeforeDismiss = detailRequests().length

    await user.click(within(section).getAllByRole("button", { name: "Dismiss suggestion" })[0]!)

    await waitFor(() => expect(within(section).queryByRole("button", { name: "Suggestion Candidate, Not installed" })).toBeNull())
    expect(within(section).getByRole("button", { name: "Suggestion Candidate 7, Not installed" })).toBeTruthy()
    expect(catalogRequests()).toHaveLength(1)
    expect(detailRequests()).toHaveLength(detailsBeforeDismiss)
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

  it("mounts with consent and 30 candidates runs the pipeline once and caps detail lookups at 20", async () => {
    const candidates30 = Array.from({ length: 30 }, (_, index) => ({
      ...CANDIDATE,
      modid: 200 + index,
      assetid: 200 + index,
      name: `Candidate ${index + 1}`,
      modidstrs: [`candidate${index + 1}`]
    }))
    const { queryURL } = mount(true, candidates30)

    const section = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    await within(section).findByRole("button", { name: "Candidate 1, Not installed" })

    const catalogRequests = (): typeof queryURL.mock.calls => queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods"))
    const detailRequests = (): typeof queryURL.mock.calls => queryURL.mock.calls.filter(([url]) => url.includes("/api/mod/"))

    await waitFor(() => expect(catalogRequests()).toHaveLength(1))
    expect(detailRequests()).toHaveLength(20)
  }, 15_000)
})

describe("Mod suggestions: folding (#546)", () => {
  it("folds and unfolds the suggestions row from its header, and a folded row makes no request", async () => {
    const user = userEvent.setup()
    const { api, queryURL } = mount(true)
    const catalogRequests = (): typeof queryURL.mock.calls => queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods"))

    const section = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    await within(section).findByText(/Popular|Recently updated|You run this/i)
    await waitFor(() => expect(catalogRequests()).toHaveLength(1))

    const toggle = within(section).getByRole("button", { name: "Suggested for Install A" })
    expect(toggle.getAttribute("aria-expanded")).toBe("true")

    await user.click(toggle)

    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(within(section).queryByRole("button", { name: "Refresh suggestions" })).toBeNull()
    expect(within(section).queryByRole("button", { name: "Suggestion Candidate, Not installed" })).toBeNull()
    // The title line stays: folding is not the same as the "no suggestions yet" empty state.
    expect(screen.getByRole("region", { name: "Suggested for Install A" })).toBeTruthy()
    await waitFor(() => expect(lastSavedConfig(api).modSuggestionsFolded).toBe(true))

    const requestsWhileFolded = catalogRequests().length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(catalogRequests()).toHaveLength(requestsWhileFolded)

    // Unfolding clears the stale, folded-away suggestions before the fetch it kicks off resolves,
    // so the row can go through a beat with nothing to show before it does: re-queried through
    // findBy (which retries) rather than the `toggle`/`section` handles above, which is exactly
    // the sort of transient the guard above is built to tolerate.
    await user.click(await screen.findByRole("button", { name: "Suggested for Install A" }))

    await waitFor(async () => expect((await screen.findByRole("button", { name: "Suggested for Install A" })).getAttribute("aria-expanded")).toBe("true"))
    await screen.findByRole("button", { name: "Refresh suggestions" })
    await waitFor(() => expect(catalogRequests().length).toBeGreaterThan(requestsWhileFolded))
    await waitFor(() => expect(lastSavedConfig(api).modSuggestionsFolded).toBe(false))
  }, 15_000)

  it("is reachable from the keyboard, toggling aria-expanded on Enter", async () => {
    const user = userEvent.setup()
    await mount(true)

    const section = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    const toggle = within(section).getByRole("button", { name: "Suggested for Install A" })

    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    await user.keyboard("{Enter}")

    expect(toggle.getAttribute("aria-expanded")).toBe("false")
  }, 15_000)

  it("a row mounted already folded (a saved config) makes no suggestion request and stays folded", async () => {
    const { queryURL } = mount(true, [CANDIDATE], true)

    const section = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    expect(within(section).getByRole("button", { name: "Suggested for Install A" }).getAttribute("aria-expanded")).toBe("false")
    expect(within(section).queryByRole("button", { name: "Refresh suggestions" })).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods"))).toHaveLength(0)
  }, 15_000)

  it("folded from the header survives a remount reading the config it was just saved to", async () => {
    const user = userEvent.setup()
    const { api } = mount(true)

    const section = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    await user.click(within(section).getByRole("button", { name: "Suggested for Install A" }))
    await waitFor(() => expect(lastSavedConfig(api).modSuggestionsFolded).toBe(true))

    cleanup()

    // A fresh mount, reading the config exactly as the first one left it saved: the render start,
    // not a second toggle, is what has to carry the folded answer forward.
    const { queryURL: secondQueryURL } = mount(true, [CANDIDATE], true)

    const reopened = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    expect(within(reopened).getByRole("button", { name: "Suggested for Install A" }).getAttribute("aria-expanded")).toBe("false")
    expect(within(reopened).queryByRole("button", { name: "Refresh suggestions" })).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(secondQueryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods"))).toHaveLength(0)
  }, 15_000)

  it("folds the opt-in card from its header too, without touching consent", async () => {
    const user = userEvent.setup()
    const { api } = mount(null)

    const toggle = await screen.findByRole("button", { name: "Discover compatible Mods" }, { timeout: 3000 })
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByRole("button", { name: "Turn on Mod suggestions" })).toBeTruthy()

    await user.click(toggle)

    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByRole("button", { name: "Turn on Mod suggestions" })).toBeNull()
    expect(screen.getByRole("button", { name: "Discover compatible Mods" })).toBeTruthy()
    expect(api.configManager.saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ modSuggestionsConsent: expect.anything() }))
    await waitFor(() => expect(lastSavedConfig(api).modSuggestionsFolded).toBe(true))
  }, 15_000)
})

describe("Mod suggestions: No thanks and Turn off (#546)", () => {
  it("No thanks hides the opt-in card and persists the refusal", async () => {
    const user = userEvent.setup()
    const { api, queryURL } = mount(null)

    await screen.findByRole("button", { name: "Turn on Mod suggestions" }, { timeout: 3000 })
    await user.click(screen.getByRole("button", { name: "No thanks" }))

    expect(screen.queryByRole("button", { name: "Turn on Mod suggestions" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Discover compatible Mods" })).toBeNull()
    await waitFor(() => expect(lastSavedConfig(api).modSuggestionsConsent).toBe(false))
    expect(queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods"))).toHaveLength(0)
  })

  it("with consent already false, mounts with no card, no row, and no suggestion request", async () => {
    const { queryURL } = mount(false)

    await screen.findByRole("button", { name: "Suggestion Candidate, Not installed" }, { timeout: 3000 })
    expect(screen.queryByRole("button", { name: "Turn on Mod suggestions" })).toBeNull()
    expect(screen.queryByRole("region", { name: "Suggested for Install A" })).toBeNull()
    expect(queryURL.mock.calls.filter(([url]) => url.endsWith("/api/mods"))).toHaveLength(0)
  })

  it("Turn off suggestions in the row sets consent back to false", async () => {
    const user = userEvent.setup()
    const { api } = mount(true)

    const section = await screen.findByRole("region", { name: "Suggested for Install A" }, { timeout: 3000 })
    await user.click(within(section).getByRole("button", { name: "Turn off suggestions" }))

    await waitFor(() => expect(screen.queryByRole("region", { name: "Suggested for Install A" })).toBeNull())
    expect(lastSavedConfig(api).modSuggestionsConsent).toBe(false)
  }, 15_000)
})
