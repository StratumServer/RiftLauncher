import { describe, expect, it, vi } from "vitest"
import { act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CONFIG_ACTIONS, useConfigDispatch, useGameVersions, useInstallations, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * #731: main answers a save that carries a path nobody trusts with `unauthorized-path` and the
 * refused paths. The renderer sends its whole state on every change, so an entry it kept would be
 * refused again by every save after it. Each way a path enters the config is covered once: a
 * VS Version (Look for a VS Version), an Installation (Browse in Add Installation), and the three
 * folders of the Config page.
 */

const REFUSAL = (...refusedPaths: string[]): SaveConfigResult => ({ ok: false, reason: "unauthorized-path", refusedPaths })

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-new",
    name: "Creative",
    icon: "icon-1",
    path: "/picked/creative",
    version: "1.21.5",
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

function Probe(): JSX.Element {
  const configDispatch = useConfigDispatch()
  const installations = useInstallations()
  const gameVersions = useGameVersions()
  const { defaultVersionsFolder } = useSettingsConfig()
  return (
    <>
      <p>installations: {installations.map((installation) => installation.name).join(",") || "none"}</p>
      <p>versions: {gameVersions.map((gameVersion) => gameVersion.label).join(",") || "none"}</p>
      <p>versions folder: {defaultVersionsFolder}</p>
      <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.ADD_INSTALLATION, payload: anInstallation() })}>add installation</button>
      <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER, payload: "/picked/versions" })}>pick versions folder</button>
      <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.ADD_FAV_MOD, payload: { modid: 7 } })}>favourite a mod</button>
    </>
  )
}

function lastSaved(saveConfig: ReturnType<typeof vi.fn>): ConfigType {
  return saveConfig.mock.calls.at(-1)?.[0] as ConfigType
}

describe("ConfigProvider when main refuses a path", () => {
  it("drops a refused Installation, names it, and lets the next save through", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async (config: ConfigType) =>
      config.installations.some((installation) => installation.path === "/picked/creative") ? REFUSAL("/picked/creative") : ({ ok: true } as SaveConfigResult)
    )
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig()), saveConfig } })

    renderWithProviders(
      <>
        <Probe />
        <NotificationsOverlay />
      </>
    )

    await user.click(await screen.findByRole("button", { name: "add installation" }))

    expect(await screen.findByText(/Couldn't keep Creative/)).toBeTruthy()
    await screen.findByText("installations: none")

    await user.click(screen.getByRole("button", { name: "favourite a mod" }))
    await waitFor(() => expect(lastSaved(saveConfig)).toMatchObject({ favMods: [7] }))
    expect(lastSaved(saveConfig).installations).toEqual([])
    await act(async () => {})
    expect(screen.queryByText(/Re-pick it on the Config page/)).toBeNull()
  })

  it("sends a refused folder setting back to the one main holds, and names the folder", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async (config: ConfigType) => (config.defaultVersionsFolder === "/picked/versions" ? REFUSAL("/picked/versions") : ({ ok: true } as SaveConfigResult)))
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ defaultVersionsFolder: "/kept/versions" })), saveConfig } })

    renderWithProviders(
      <>
        <Probe />
        <NotificationsOverlay />
      </>
    )

    await user.click(await screen.findByRole("button", { name: "pick versions folder" }))

    expect(await screen.findByText(/Couldn't keep \/picked\/versions/)).toBeTruthy()
    await screen.findByText("versions folder: /kept/versions")

    await user.click(screen.getByRole("button", { name: "favourite a mod" }))
    await waitFor(() => expect(lastSaved(saveConfig)).toMatchObject({ favMods: [7], defaultVersionsFolder: "/kept/versions" }))
  })

  it("names every refused entry in one notice and counts none of it as a failing streak", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async (config: ConfigType) => {
      const refused = [...config.installations.map((installation) => installation.path), ...config.gameVersions.map((gameVersion) => gameVersion.path)].filter((path) => path.startsWith("/picked/"))
      return refused.length > 0 ? REFUSAL(...refused) : ({ ok: true } as SaveConfigResult)
    })
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "gv-1", version: "1.21.5", label: "Mine", path: "/picked/mine" }] })), saveConfig }
    })

    renderWithProviders(
      <>
        <Probe />
        <NotificationsOverlay />
      </>
    )

    // The version already in the state is refused on the first save, and so is the Installation
    // added in the same breath: two saves in flight, both refused, the second one late.
    await user.click(await screen.findByRole("button", { name: "add installation" }))

    await screen.findByText("installations: none")
    await screen.findByText("versions: none")
    await act(async () => {})
    expect(screen.queryByText(/Re-pick it on the Config page/)).toBeNull()
    expect(screen.getAllByText(/Couldn't keep/).length).toBeGreaterThan(0)
  })

  it("does not count refusals that come back late for an entry already dropped as a failing streak", async () => {
    const user = userEvent.setup()
    // Every answer waits for the test, so the saves overlap the way a slow disk makes them.
    const pending: { config: ConfigType; answer: (result: SaveConfigResult) => void }[] = []
    const saveConfig = vi.fn((config: ConfigType) => new Promise<SaveConfigResult>((answer) => pending.push({ config, answer })))
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig()), saveConfig } })

    renderWithProviders(
      <>
        <Probe />
        <NotificationsOverlay />
      </>
    )
    await screen.findByRole("button", { name: "add installation" })

    // At least three saves in flight, all carrying the Installation main will refuse.
    await user.click(screen.getByRole("button", { name: "add installation" }))
    await user.click(screen.getByRole("button", { name: "favourite a mod" }))
    await user.click(screen.getByRole("button", { name: "pick versions folder" }))
    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(3))
    const inFlight = pending.splice(0)
    expect(inFlight.every(({ config }) => config.installations.length === 1)).toBe(true)

    // The first answer drops the Installation, which sends a clean save that goes through.
    await act(async () => inFlight[0]!.answer(REFUSAL("/picked/creative")))
    await screen.findByText("installations: none")
    await waitFor(() => expect(pending.length).toBe(1))
    await act(async () => pending.splice(0)[0]!.answer({ ok: true }))

    // The others were for saves sent before the drop. They name what is already gone.
    for (const { answer } of inFlight.slice(1)) await act(async () => answer(REFUSAL("/picked/creative")))

    expect(screen.queryByText(/Re-pick it on the Config page/)).toBeNull()
    expect(screen.getAllByText(/Couldn't keep Creative/)).toHaveLength(1)
  })

  it("falls back to the save health notice when the refused paths are not ones the state holds", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => REFUSAL("/nothing/like/it"))
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig()), saveConfig } })

    renderWithProviders(
      <>
        <Probe />
        <NotificationsOverlay />
      </>
    )

    const favourite = await screen.findByRole("button", { name: "favourite a mod" })
    await user.click(favourite)
    await act(async () => {})
    await user.click(screen.getByRole("button", { name: "add installation" }))

    expect(await screen.findByText(/Re-pick it on the Config page/)).toBeTruthy()
    expect(screen.queryByText(/Couldn't keep/)).toBeNull()
  })

  it("leaves a save that names no paths to the save health notice", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: false, reason: "unauthorized-path" }) as SaveConfigResult)
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig()), saveConfig } })

    renderWithProviders(
      <>
        <Probe />
        <NotificationsOverlay />
      </>
    )

    await user.click(await screen.findByRole("button", { name: "favourite a mod" }))
    await act(async () => {})
    await user.click(screen.getByRole("button", { name: "add installation" }))

    expect(await screen.findByText(/Re-pick it on the Config page/)).toBeTruthy()
  })
})
