import { afterEach, describe, expect, it, vi } from "vitest"
import { act, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { mountManageMods } from "./helpers/mountManageMods"
import GlobalModUpdateChecker from "@renderer/components/layout/GlobalModUpdateChecker"
import { resetStartupModUpdateNoticesForTests } from "@renderer/features/mods/modUpdateNotices"

// #800: enabling, disabling or deleting one Mod re-reads the folder and reuses what the last full
// scan learned from the ModDB, so a toggle never waits on the network.
const N = 3
const DISABLE = "Disable this Mod: it stays installed, Vintage Story just won't load it"
const ENABLE = "Enable this Mod: Vintage Story will load it again"

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

function detail(url: string, newer = false): string {
  const id = url.split("/").pop() ?? ""
  const n = Number(id.slice(1))
  return JSON.stringify({
    statuscode: "200",
    mod: {
      modid: n,
      assetid: n + 100,
      name: `Mod ${n}`,
      logofile: `https://moddbcdn.vintagestory.at/${id}.png`,
      releases: [
        ...(newer && id === "m1"
          ? [
              {
                releaseid: 99,
                mainfile: "https://mods.example/m1-new.zip",
                filename: "m1-new.zip",
                fileid: 99,
                downloads: 0,
                tags: ["1.20.0"],
                modidstr: id,
                modversion: "1.1.0",
                created: "",
                changelog: ""
              }
            ]
          : []),
        { releaseid: n, mainfile: `https://mods.example/${id}.zip`, filename: `${id}.zip`, fileid: n, downloads: 0, tags: ["1.20.0"], modidstr: id, modversion: "1.0.0", created: "", changelog: "" }
      ]
    }
  })
}

/** A folder that remembers renames, like a real one. `count` is read at each scan, so a test can add a Mod. */
function mount(
  queryURL: (url: string) => Promise<string>,
  logo: () => Promise<string | undefined> = async () => undefined
): {
  q: ReturnType<typeof vi.fn<(url: string) => Promise<string>>>
  getInstalledMods: ReturnType<typeof vi.fn>
  cacheModImage: ReturnType<typeof vi.fn>
  setModEnabled: ReturnType<typeof vi.fn>
  folder: { count: number }
} {
  const enabled = new Map<string, boolean>()
  const folder = { count: N }
  const q = vi.fn(queryURL)
  const getInstalledMods = vi.fn(async () => ({
    mods: Array.from({ length: folder.count }, (_, i) => {
      const path = `/games/a/Mods/m${i + 1}-1.0.0.zip`
      return { name: `Mod ${i + 1}`, modid: `m${i + 1}`, version: "1.0.0", path, enabled: enabled.get(path) ?? true, authors: [], contributors: [] }
    }),
    errors: []
  }))
  const cacheModImage = vi.fn(logo)
  const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string, on: boolean) => {
    enabled.set(path, on)
    return { ok: true, path }
  })
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    netManager: { queryURL: q },
    modsManager: { getInstalledMods, cacheModImage, setModEnabled }
  })
  mountManageMods()
  return { q, getInstalledMods, cacheModImage, setModEnabled, folder }
}

const rowOf = (name: string): HTMLElement => screen.getByText(name).closest("li") as HTMLElement
const shows = (name: string, title: string): boolean => within(rowOf(name)).queryByTitle(title) !== null

describe("Manage Mods actions and the network (#800)", () => {
  // Held lookups live at describe scope: the lookup limiter is module level, so a failing test must still free them.
  const pending: Array<() => void> = []
  const logos: Array<() => void> = []
  afterEach(() => {
    pending.splice(0).forEach((release) => release())
    logos.splice(0).forEach((release) => release())
  })

  it("a toggle after a full scan asks neither the ModDB nor the logo cache, and shows the new state", async () => {
    const user = userEvent.setup()
    const m = mount(async (url) => detail(url))
    await screen.findByText("Mod 1")
    await waitFor(() => expect(m.q).toHaveBeenCalledTimes(N))
    await waitFor(() => expect(m.cacheModImage).toHaveBeenCalledTimes(N))

    await user.click(within(rowOf("Mod 1")).getByTitle(DISABLE))

    await waitFor(() => expect(m.getInstalledMods).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(shows("Mod 1", ENABLE)).toBe(true))
    expect(m.q).toHaveBeenCalledTimes(N)
    expect(m.cacheModImage).toHaveBeenCalledTimes(N)
  })

  it("after a full scan whose lookups all failed, a toggle resolves without any new lookup", async () => {
    const user = userEvent.setup()
    const m = mount(() => Promise.reject(new Error("net::ERR_NETWORK_CHANGED")))
    await screen.findByText("Mod 1")
    await waitFor(() => expect(m.q).toHaveBeenCalledTimes(N))

    await user.click(within(rowOf("Mod 1")).getByTitle(DISABLE))

    await waitFor(() => expect(shows("Mod 1", ENABLE)).toBe(true))
    expect(m.q).toHaveBeenCalledTimes(N)
  })

  it("a Reload still in flight does not overwrite a later toggle with its older folder read", async () => {
    const user = userEvent.setup()
    let hold = false
    const m = mount((url) => (hold ? new Promise((resolve) => pending.push(() => resolve(detail(url)))) : Promise.resolve(detail(url))))
    await screen.findByText("Mod 1")
    await waitFor(() => expect(m.q).toHaveBeenCalledTimes(N))
    hold = true

    await user.click(screen.getByTitle("Reload"))
    await waitFor(() => expect(pending.length).toBe(2))
    await user.click(within(rowOf("Mod 1")).getByTitle(DISABLE))
    await waitFor(() => expect(shows("Mod 1", ENABLE)).toBe(true))

    await waitFor(() => {
      pending.splice(0).forEach((release) => release())
      expect(m.q).toHaveBeenCalledTimes(N * 2)
    })
    await waitFor(() => expect(screen.getByTitle("Reload")).toBeTruthy())
    expect(shows("Mod 1", ENABLE)).toBe(true)
  })

  it("Reload still runs a full scan", async () => {
    const user = userEvent.setup()
    const m = mount(async (url) => detail(url))
    await screen.findByText("Mod 1")
    await waitFor(() => expect(m.q).toHaveBeenCalledTimes(N))

    await user.click(screen.getByTitle("Reload"))

    await waitFor(() => expect(m.q).toHaveBeenCalledTimes(N * 2))
  })

  it("a Mod the last scan never saw is looked up once after an action", async () => {
    const user = userEvent.setup()
    const m = mount(async (url) => detail(url))
    await screen.findByText("Mod 1")
    await waitFor(() => expect(m.q).toHaveBeenCalledTimes(N))

    m.folder.count = N + 1
    await user.click(within(rowOf("Mod 1")).getByTitle(DISABLE))

    await screen.findByText("Mod 4")
    expect(m.q).toHaveBeenCalledTimes(N + 1)
    expect(m.q.mock.calls[N]?.[0]).toContain(`m${N + 1}`)
  })

  it("a toggle overtaken by a Reload does not release its row on the old state", async () => {
    const user = userEvent.setup()
    let hold = false
    const m = mount((url) => (hold ? new Promise((resolve) => pending.push(() => resolve(detail(url)))) : Promise.resolve(detail(url))))
    await screen.findByText("Mod 1")
    await waitFor(() => expect(m.q).toHaveBeenCalledTimes(N))

    // Hold the toggle's folder read, then start a Reload whose lookups are held too.
    const read = m.getInstalledMods.getMockImplementation() as () => Promise<unknown>
    let releaseRead: () => void = () => {}
    m.getInstalledMods.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (releaseRead = resolve))
      return read()
    })
    await user.click(within(rowOf("Mod 1")).getByTitle(DISABLE))
    await waitFor(() => expect(m.getInstalledMods).toHaveBeenCalledTimes(2))
    hold = true
    // The toggle's scan is still running, so the button reads "Reloading".
    await user.click(screen.getByTitle("Reloading"))
    await waitFor(() => expect(pending.length).toBe(2))
    releaseRead()

    // The row shows the new state, or it is still busy, but never a clickable old state.
    await waitFor(() => expect(shows("Mod 1", ENABLE)).toBe(true))
    // The Reload started after the toggle's scan, so the toggle landing must not stop its spinner.
    expect(screen.getByTitle("Reloading")).toBeTruthy()
    // Let the Reload finish, so its lookup slots are free for the next test.
    await waitFor(() => {
      pending.splice(0).forEach((release) => release())
      expect(m.q).toHaveBeenCalledTimes(N * 2)
    })
    await waitFor(() => expect(screen.getByTitle("Reload")).toBeTruthy())
  })

  it("a full scan overtaken by a toggle still keeps its answers for later actions", async () => {
    const user = userEvent.setup()
    let hold = false
    let newer = false
    const m = mount((url) => (hold ? new Promise((resolve) => pending.push(() => resolve(detail(url, newer)))) : Promise.resolve(detail(url, newer))))
    await screen.findByText("Mod 1")
    await waitFor(() => expect(m.q).toHaveBeenCalledTimes(N))
    hold = true
    newer = true

    await user.click(screen.getByTitle("Reload"))
    await waitFor(() => expect(pending.length).toBe(2))
    await user.click(within(rowOf("Mod 1")).getByTitle(DISABLE))
    await waitFor(() => expect(shows("Mod 1", ENABLE)).toBe(true))
    expect(screen.queryByText("Mods with updates")).toBeNull()

    await waitFor(() => {
      pending.splice(0).forEach((release) => release())
      expect(m.q).toHaveBeenCalledTimes(N * 2)
    })
    await waitFor(() => expect(screen.getByTitle("Reload")).toBeTruthy())
    await user.click(within(rowOf("Mod 1")).getByTitle(ENABLE))

    // The Reload's newer release now shows, and no lookup was made for it.
    await screen.findByText("Mods with updates")
    expect(m.q).toHaveBeenCalledTimes(N * 2)
  })

  it("an older full scan that lands after a newer one does not replace its answers", async () => {
    const user = userEvent.setup()
    let holdLogos = true
    const m = mount(
      async (url) => detail(url),
      () => (holdLogos ? new Promise<string | undefined>((resolve) => logos.push(() => resolve(undefined))) : Promise.resolve(undefined))
    )
    await waitFor(() => expect(logos.length).toBe(N))

    // The page-open scan is stuck on its logos. A Reload finds a 4th Mod and lands first.
    holdLogos = false
    m.folder.count = N + 1
    await user.click(screen.getByTitle("Reloading"))
    await screen.findByText("Mod 4")
    expect(m.q).toHaveBeenCalledTimes(N + N + 1)

    await act(async () => {
      logos.splice(0).forEach((release) => release())
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await user.click(within(rowOf("Mod 1")).getByTitle(DISABLE))

    await waitFor(() => expect(shows("Mod 1", ENABLE)).toBe(true))
    expect(m.q).toHaveBeenCalledTimes(N + N + 1)
  })
})

// #752 x #800: the startup notice is resolved only by a complete scan that finds no update, and a
// refresh that reuses cached answers must count those answers exactly as a fresh lookup would.
describe("startup update notice and cached refreshes (#800 with #752)", () => {
  const pending: Array<() => void> = []
  afterEach(() => pending.splice(0).forEach((release) => release()))
  const notice = /Mods? with (?:an )?updates? available/i
  const UPDATE = "Update"

  function mountWithNotice(queryURL: (url: string) => Promise<string>): { q: ReturnType<typeof vi.fn<(url: string) => Promise<string>>>; updated: Set<string> } {
    resetStartupModUpdateNoticesForTests()
    const enabled = new Map<string, boolean>()
    const updated = new Set<string>()
    const q = vi.fn(queryURL)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: "install-a", installations: [anInstallation()] })) },
      netManager: { queryURL: q },
      modsManager: {
        getInstalledMods: vi.fn(async () => ({
          mods: Array.from({ length: N }, (_, i) => {
            const id = `m${i + 1}`
            const version = id === "m1" && updated.has(id) ? "1.1.0" : "1.0.0"
            const path = `/games/a/Mods/${id}-${version}.zip`
            return { name: `Mod ${i + 1}`, modid: id, version, path, enabled: enabled.get(path) ?? true, authors: [], contributors: [] }
          }),
          errors: []
        })),
        cacheModImage: vi.fn(async () => undefined),
        setModEnabled: vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string, on: boolean) => {
          enabled.set(path, on)
          return { ok: true, path }
        })
      },
      pathsManager: {
        deletePath: vi.fn(async () => true),
        downloadOnPath: vi.fn(async () => {
          updated.add("m1")
          return "/games/a/Mods/m1-1.1.0.zip"
        })
      }
    })
    mountManageMods(undefined, <GlobalModUpdateChecker />)
    return { q, updated }
  }

  it("a toggle after a scan with failed lookups does not resolve the notice", async () => {
    const user = userEvent.setup()
    const m = mountWithNotice((url) => (url.endsWith("m2") ? Promise.reject(new Error("offline")) : Promise.resolve(detail(url, true))))
    await screen.findByText(notice, {}, { timeout: 4_000 })
    await screen.findByTitle("Reload")
    await waitFor(() => expect(m.q.mock.calls.filter(([u]) => u.endsWith("m3")).length).toBeGreaterThan(0))
    const lookups = m.q.mock.calls.length

    await user.click(within(rowOf("Mod 3")).getByTitle(DISABLE))
    await waitFor(() => expect(shows("Mod 3", ENABLE)).toBe(true))
    await screen.findByTitle("Reload")

    expect(m.q).toHaveBeenCalledTimes(lookups)
    expect(screen.getByText(notice)).toBeTruthy()
  })

  it("a toggle of another Mod while an update is still available does not resolve the notice", async () => {
    const user = userEvent.setup()
    const m = mountWithNotice(async (url) => detail(url, true))
    await screen.findByText(notice, {}, { timeout: 4_000 })
    await screen.findByTitle("Reload")
    const lookups = m.q.mock.calls.length

    await user.click(within(rowOf("Mod 2")).getByTitle(DISABLE))
    await waitFor(() => expect(shows("Mod 2", ENABLE)).toBe(true))
    await screen.findByTitle("Reload")

    expect(m.q).toHaveBeenCalledTimes(lookups)
    expect(screen.getByText(notice)).toBeTruthy()
  })

  it("updating the last updatable Mod from its row resolves the notice from cached answers", async () => {
    const user = userEvent.setup()
    const m = mountWithNotice(async (url) => detail(url, true))
    await screen.findByText(notice, {}, { timeout: 4_000 })
    await screen.findByTitle("Reload")
    const lookups = m.q.mock.calls.length

    await user.click(within(rowOf("Mod 1")).getByTitle(UPDATE))
    await user.click(within(await screen.findByRole("dialog")).getByTitle("Author tagged it as compatible with your selected Vintage Story Version."))

    await waitFor(() => expect(screen.queryByText(notice)).toBeNull())
    // The scan after the update read its answers from the cache: no lookup for any of the three Mods.
    expect(m.q.mock.calls.slice(lookups).filter(([u]) => u.endsWith("m2") || u.endsWith("m3"))).toHaveLength(0)
  })

  it("a full scan overtaken by a toggle does not resolve the notice on its older read", async () => {
    const user = userEvent.setup()
    let hold = false
    let newer = true
    const m = mountWithNotice((url) => (hold ? new Promise((resolve) => pending.push(() => resolve(detail(url, newer)))) : Promise.resolve(detail(url, newer))))
    await screen.findByText(notice, {}, { timeout: 4_000 })
    await screen.findByTitle("Reload")
    hold = true
    newer = false

    // The Reload's answers carry no update, but its scan is superseded by the toggle's.
    await user.click(screen.getByTitle("Reload"))
    await waitFor(() => expect(pending.length).toBe(2))
    await user.click(within(rowOf("Mod 2")).getByTitle(DISABLE))
    await waitFor(() => expect(shows("Mod 2", ENABLE)).toBe(true))
    await waitFor(() => {
      pending.splice(0).forEach((release) => release())
      expect(m.q.mock.calls.length).toBeGreaterThanOrEqual(N * 3)
    })
    await waitFor(() => expect(screen.getByTitle("Reload")).toBeTruthy())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    })

    expect(screen.getByText(notice)).toBeTruthy()
  })
})
