import { describe, expect, it, vi } from "vitest"
import { memo, createElement, useRef } from "react"
import { act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { CONFIG_ACTIONS, useConfigDispatch, useInstallations } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Replaces the real ModListCard with a spy and wraps that spy in memo(), so the only thing
 * that can make the spy run again is a prop whose identity changed. The real ModListCard's
 * own memo() is out of the picture here: this file never imports it. That makes this suite a
 * probe on what ModsGrid hands each card (the mod object plus the three callbacks ListMods
 * builds with useCallback), not a check that the shipped component is memoized. The memo on
 * the real export is pinned separately, against the unmocked component, in
 * modListCardMemo.test.tsx.
 *
 * The mock is scoped to this file only (vi.mock is per-module-per-test-file), so other
 * suites still exercise the real component.
 */
const { cardRenderSpy } = vi.hoisted(() => ({
  cardRenderSpy: vi.fn((props: { mod: { modid: number; name: string } }) => createElement("div", { "data-testid": `mod-card-${props.mod.modid}` }, props.mod.name))
}))
vi.mock("@renderer/features/mods/components/ModListCard", () => ({
  default: memo(cardRenderSpy)
}))

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
    ...overrides
  }
}

/**
 * Edits a field ModsGrid's props never depend on (start params), so the only thing this
 * proves is whether an unrelated ListMods re-render hands a card a prop it did not have
 * before. id and path stay untouched, so the installed-mods rescan effect (keyed on
 * installation?.id/path) never refires either.
 */
function EditInstallationStartParamsButton(): JSX.Element {
  const configDispatch = useConfigDispatch()
  return <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: "install-a", updates: { startParams: "--unrelated-flag" } } })}>edit start params</button>
}

describe("ModsGrid card prop identity", () => {
  it("hands a mod card the same props when ListMods re-renders for an unrelated reason", async () => {
    const user = userEvent.setup()

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: "install-a", installations: [anInstallation()] }))
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
        <EditInstallationStartParamsButton />
      </TaskProvider>,
      { route: "/mods" }
    )

    await screen.findByTestId("mod-card-123", {}, { timeout: 3000 })
    expect(cardRenderSpy).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole("button", { name: "edit start params" }))

    // No observable effect of the edit reaches ModsGrid, so there is nothing to await on
    // the mods side; give React a tick to flush the re-render this dispatch does cause.
    await waitFor(() => expect(cardRenderSpy.mock.calls.length).toBeGreaterThanOrEqual(1))

    expect(cardRenderSpy).toHaveBeenCalledTimes(1)
  })

  /**
   * The same probe with an Installation selected and one Mod installed: the card props now carry
   * that copy's state and one action callback. An unrelated edit must not re-identify any of them,
   * and a rescan, which hands the page a new object for every installed copy, must re-render only
   * the card whose state it changed.
   */
  it("hands an installed card and its neighbour the same props across an unrelated edit and the other's rescan", async () => {
    const user = userEvent.setup()
    const { rendersOf, setModEnabled } = mountWithOneInstalledMod()

    await settle(user)
    const installedRenders = rendersOf(123).length
    const neighbourRenders = rendersOf(456).length

    await user.click(screen.getByRole("button", { name: "bump start params" }))
    await waitFor(() => expect(screen.getByTestId("start-params").textContent).toBe("--bump-2"))
    expect(rendersOf(123)).toHaveLength(installedRenders)
    expect(rendersOf(456)).toHaveLength(neighbourRenders)

    const neighbourBefore = rendersOf(456).at(-1) as CardProps
    const installed = rendersOf(123).at(-1) as CardProps
    await act(async () => {
      await installed.onAction(installed.mod, "toggle-enabled")
    })

    expect(setModEnabled).toHaveBeenCalledTimes(1)
    expect(rendersOf(123).at(-1)?.copyState).toBe("disabled")
    // The rename's toast re-renders every card through onSelect alone: NotificationsContext rebuilds
    // addNotification on each render, which re-identifies ListMods' onSelectMod. That predates the
    // card actions. What is pinned here is that nothing the actions add moves for the other card.
    const neighbourAfter = rendersOf(456).at(-1) as CardProps
    for (const [key, value] of Object.entries(neighbourAfter)) if (key !== "onSelect") expect(value, key).toBe(neighbourBefore[key as keyof CardProps])
  })

  it("does not quick-install a Mod the last scan holds, whatever its card last showed", async () => {
    const user = userEvent.setup()
    const { rendersOf, downloadOnPath, detailLookups } = mountWithOneInstalledMod()

    await settle(user)
    const lookups = detailLookups()
    const installed = rendersOf(123).at(-1) as CardProps
    await act(async () => {
      await installed.onAction(installed.mod, "install")
    })

    expect(downloadOnPath).not.toHaveBeenCalled()
    expect(detailLookups()).toEqual(lookups)
  })

  it("acts on neither copy of a Mod the last scan holds twice, whatever its card is handed", async () => {
    const { rendersOf, setModEnabled } = mountWithOneInstalledMod([ENABLED_COPY, { ...ENABLED_COPY, path: "/games/a/Mods/betterruins-1.0.0.zip.disabled", enabled: false }])

    await waitFor(() => expect(rendersOf(123).some((props) => props.copyState === "several")).toBe(true), { timeout: 3000 })
    // Which of two files the player meant is theirs to say, in Manage Mods; a card never picks one.
    const card = rendersOf(123).at(-1) as CardProps
    await act(async () => {
      await card.onAction(card.mod, "toggle-enabled")
    })

    expect(setModEnabled).not.toHaveBeenCalled()
  })

  it("toggling one pick re-renders only that card", async () => {
    const user = userEvent.setup()
    const { rendersOf } = mountWithOneInstalledMod()

    await settle(user)
    await user.click(screen.getByRole("button", { name: "Select Mods to install together" }))
    await waitFor(() => expect(rendersOf(456).at(-1)?.picked).toBe(false))
    const neighbourRenders = rendersOf(456).length

    const picked = rendersOf(123).at(-1) as CardProps
    act(() => picked.onSelect(picked.mod))

    await waitFor(() => expect(rendersOf(123).at(-1)?.picked).toBe(true))
    expect(rendersOf(456)).toHaveLength(neighbourRenders)
  })
})

type CardProps = {
  mod: DownloadableModOnListType
  copyState?: string
  updateTo?: string
  picked?: boolean
  onSelect: (mod: DownloadableModOnListType) => void
  onAction: (mod: DownloadableModOnListType, action: "toggle-enabled" | "install") => Promise<unknown>
}

/** Writes a new start-params value on every click, so each one is a real config edit ListMods re-renders for. */
function BumpStartParamsButton(): JSX.Element {
  const configDispatch = useConfigDispatch()
  const installations = useInstallations()
  const bumps = useRef(0)
  return (
    <>
      <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: "install-a", updates: { startParams: `--bump-${++bumps.current}` } } })}>bump start params</button>
      <output data-testid="start-params">{installations[0]?.startParams}</output>
    </>
  )
}

const ENABLED_COPY: InstalledModType = { name: "Better Ruins", modid: "betterruins", version: "1.0.0", path: "/games/a/Mods/betterruins-1.0.0.zip", enabled: true }

/** Better Ruins installed, by default once, with a newer release tagged for the build; Primitive Survival not installed. */
function mountWithOneInstalledMod(initialFolder: InstalledModType[] = [ENABLED_COPY]): {
  rendersOf: (modid: number) => CardProps[]
  setModEnabled: ReturnType<typeof vi.fn>
  downloadOnPath: ReturnType<typeof vi.fn>
  detailLookups: () => string[]
} {
  cardRenderSpy.mockClear()

  let folder = initialFolder
  const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string) => {
    folder = [{ ...ENABLED_COPY, path: `${path}.disabled`, enabled: false }]
    return { ok: true, path: `${path}.disabled` }
  })
  const downloadOnPath = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(async (_id, _url, outputPath, fileName) => `${outputPath}/${fileName}`)
  const catalog = { statuscode: "200", mods: [...MOD_RESPONSE.mods, { ...MOD_RESPONSE.mods[0], modid: 456, assetid: 456, name: "Primitive Survival", modidstrs: ["primitivesurvival"] }] }
  const detail = {
    statuscode: "200",
    mod: { modid: 123, name: "Better Ruins", releases: [{ releaseid: 2, mainfile: "https://mods.example/betterruins-1.5.0.zip", modidstr: "betterruins", modversion: "1.5.0", tags: ["1.20.0"] }] }
  }
  const queryURL = vi.fn(async (url: string) => {
    if (url.includes("/api/mods")) return JSON.stringify(catalog)
    if (url.endsWith("/api/mod/123")) return JSON.stringify(detail)
    return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
  })

  installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () => createMockConfig({ lastUsedInstallation: "install-a", installations: [anInstallation()] }))
    },
    modsManager: { getInstalledMods: vi.fn(async () => ({ mods: folder, errors: [] })), setModEnabled },
    pathsManager: { downloadOnPath },
    netManager: { queryURL }
  })

  renderWithProviders(
    <TaskProvider>
      <ListMods />
      <BumpStartParamsButton />
    </TaskProvider>,
    { route: "/mods" }
  )

  const rendersOf = (modid: number): CardProps[] => (cardRenderSpy.mock.calls as unknown as [CardProps][]).map(([props]) => props).filter((props) => props.mod.modid === modid)
  const detailLookups = (): string[] => queryURL.mock.calls.map(([url]) => url).filter((url) => /\/api\/mod\/\d+$/.test(url))
  return { rendersOf, setModEnabled, downloadOnPath, detailLookups }
}

/**
 * Waits for the details to land and the page to stop moving. GridGroup's AnimatePresence repaints
 * its children from an older snapshot once the loading spinner's exit ends, so the cards only read
 * current after the next real re-render of the page, which one config edit provides.
 */
async function settle(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => expect(screen.queryAllByTestId(/^mod-card-/)).toHaveLength(2), { timeout: 3000 })
  await waitFor(() => expect(document.querySelector(".animate-spin")).toBeNull(), { timeout: 3000 })
  await waitFor(() => expect(window.api.netManager.queryURL).toHaveBeenCalledWith("https://mods.vintagestory.at/api/mod/123"), { timeout: 3000 })
  await user.click(screen.getByRole("button", { name: "bump start params" }))
  await waitFor(() => expect(screen.getByTestId("start-params").textContent).toBe("--bump-1"))
  await waitFor(() => {
    const calls = cardRenderSpy.mock.calls as unknown as [CardProps][]
    const last = calls.filter(([props]) => props.mod.modid === 123).at(-1)?.[0]
    expect(last).toMatchObject({ copyState: "enabled", updateTo: "1.5.0" })
  })
}
