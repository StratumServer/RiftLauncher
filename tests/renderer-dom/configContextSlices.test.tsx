import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CONFIG_ACTIONS, useAccountList, useConfigDispatch, useCustomIcons, useFavMods, useGameVersions, useInstallations, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { expectHookThrowsOutsideProvider, renderWithProviders } from "./helpers/render"

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
 * The config the probes start from. lastUsedInstallation already points at the
 * installation on purpose: leaving it null makes ConfigProvider's "pick the
 * first installation" effect fire a second action, and this test is counting
 * renders per action.
 */
function seededConfig(): ConfigType {
  return createMockConfig({
    lastUsedInstallation: "install-a",
    installations: [anInstallation()],
    gameVersions: [{ version: "1.20.0", path: "/versions/1.20.0" }]
  })
}

/** Counts how often each named probe has rendered, across one test. */
type RenderLog = Record<string, number>

function countRender(log: RenderLog, name: string): void {
  log[name] = (log[name] ?? 0) + 1
}

function InstallationsProbe({ log }: { log: RenderLog }): JSX.Element {
  const installations = useInstallations()
  countRender(log, "installations")
  return <p>installations: {installations.length}</p>
}

function GameVersionsProbe({ log }: { log: RenderLog }): JSX.Element {
  const gameVersions = useGameVersions()
  countRender(log, "gameVersions")
  return <p>gameVersions: {gameVersions.length}</p>
}

/**
 * Stands in for the pre-split consumer. `useConfigContext` handed out the whole
 * config, so a component was subscribed to all of it whether it read all of it
 * or not; subscribing to every slice at once reproduces exactly that.
 */
function WholeConfigProbe({ log }: { log: RenderLog }): JSX.Element {
  useInstallations()
  useGameVersions()
  useAccountList()
  useSettingsConfig()
  useFavMods()
  useCustomIcons()
  countRender(log, "wholeConfig")
  return <p>whole config</p>
}

function Dispatchers(): JSX.Element {
  const configDispatch = useConfigDispatch()
  return (
    <>
      <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: "1.20.0", updates: { _installing: true } } })}>edit game version</button>
      <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: "install-a", updates: { _modsCount: 7 } } })}>edit installation</button>
    </>
  )
}

describe("config slice contexts", () => {
  it("only re-renders the domains an action actually touched", async () => {
    const user = userEvent.setup()
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => seededConfig()) } })

    const log: RenderLog = {}
    renderWithProviders(
      <>
        <InstallationsProbe log={log} />
        <GameVersionsProbe log={log} />
        <WholeConfigProbe log={log} />
        <Dispatchers />
      </>
    )

    // Mount plus the SET_CONFIG that lands when getConfig resolves. Counting
    // from here keeps the assertions about the dispatches, not about startup.
    await screen.findByText("installations: 1")
    const mounted = { ...log }

    await user.click(screen.getByRole("button", { name: "edit game version" }))

    expect(log.gameVersions! - mounted.gameVersions!).toBe(1)
    expect(log.installations! - mounted.installations!).toBe(0)
    expect(log.wholeConfig! - mounted.wholeConfig!).toBe(1)

    await user.click(screen.getByRole("button", { name: "edit installation" }))

    expect(log.installations! - mounted.installations!).toBe(1)
    expect(log.gameVersions! - mounted.gameVersions!).toBe(1)
    // Two actions, two renders: what every consumer used to cost.
    expect(log.wholeConfig! - mounted.wholeConfig!).toBe(2)
  })

  it("leaves the untouched slices referentially identical, which is what lets React bail out", async () => {
    const user = userEvent.setup()
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => seededConfig()) } })

    const seen: { installations: InstallationType[][]; gameVersions: GameVersionType[][] } = { installations: [], gameVersions: [] }

    function SliceRecorder(): JSX.Element {
      const installations = useInstallations()
      const gameVersions = useGameVersions()
      // Recorded on every render of a component subscribed to both slices, so
      // a stale reference cannot hide behind a bailout.
      seen.installations.push(installations)
      seen.gameVersions.push(gameVersions)
      return <p>recorder: {installations.length}</p>
    }

    renderWithProviders(
      <>
        <SliceRecorder />
        <Dispatchers />
      </>
    )

    await screen.findByText("recorder: 1")
    const installationsAtStart = seen.installations.at(-1)

    await user.click(screen.getByRole("button", { name: "edit game version" }))

    expect(seen.installations.at(-1)).toBe(installationsAtStart)
    expect(seen.gameVersions.at(-1)).not.toBe(seen.gameVersions.at(-2))
  })

  it("throws by name when a slice hook is used outside the provider", () => {
    expectHookThrowsOutsideProvider(useInstallations, /useInstallations must be used within a ConfigProvider/)
  })
})
