import { afterEach, describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import MainMenu from "@renderer/components/layout/MainMenu"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { useGameVersions, useInstallations } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Exercises src/renderer/src/features/launch/{adapters/launch.ts, hooks/useLaunchGame.ts}
 * through MainMenu's Play button and its quick-backup icon, the only two call sites those
 * files have. Nothing here mocks the launch feature itself: window.api is the only seam,
 * so a real click runs the real adapter functions end to end.
 */

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

function aGameVersion(overrides: Partial<GameVersionType> = {}): GameVersionType {
  return {
    version: "1.20.0",
    path: "/versions/1.20.0",
    ...overrides
  }
}

/** Reads installations/gameVersions straight out of ConfigContext: the same state PlayHandler reads and writes. */
function ConfigProbe(): JSX.Element {
  const installations = useInstallations()
  const gameVersions = useGameVersions()
  const installation = installations[0]
  const gameVersion = gameVersions[0]

  return (
    <p data-testid="probe">
      {JSON.stringify({
        installationPlaying: installation?._playing ?? false,
        gameVersionPlaying: gameVersion?._playing ?? false,
        lastTimePlayed: installation?.lastTimePlayed,
        totalTimePlayed: installation?.totalTimePlayed
      })}
    </p>
  )
}

interface ProbeState {
  installationPlaying: boolean
  gameVersionPlaying: boolean
  lastTimePlayed: number
  totalTimePlayed: number
}

function readProbe(): ProbeState {
  return JSON.parse(screen.getByTestId("probe").textContent ?? "{}") as ProbeState
}

function renderMainMenu(): void {
  renderWithProviders(
    <TaskProvider>
      <NotificationsOverlay />
      <MainMenu />
      <ConfigProbe />
    </TaskProvider>
  )
}

async function clickPlay(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Play" }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("MainMenu Play button", () => {
  it("runs the selected installation and version, flips _playing for the run, and records playtime", async () => {
    const user = userEvent.setup()

    let resolveRun!: (result: GameExecutionResult) => void
    const runPromise = new Promise<GameExecutionResult>((resolve) => {
      resolveRun = resolve
    })
    const executeGame = vi.fn(() => runPromise)

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            lastUsedInstallation: "install-a",
            installations: [anInstallation({ totalTimePlayed: 100 })],
            gameVersions: [aGameVersion()]
          })
        )
      },
      gameManager: { executeGame }
    })

    renderMainMenu()
    await screen.findByRole("button", { name: "Play" })

    // Real clock, bounded rather than pinned to exact values: motion/react's
    // mounted animations read Date.now() of their own accord during the click
    // and the pending await, so stubbing it out from under PlayHandler is not
    // reliable here. The window below is still tight enough to catch a launch
    // that forgets to record playtime, or one that back-dates/future-dates it.
    const beforeLaunch = Date.now()

    await clickPlay(user)

    // executeGame gets the exact installation and version PlayHandler resolved, not just any object.
    expect(executeGame).toHaveBeenCalledWith(expect.objectContaining({ version: "1.20.0" }), expect.objectContaining({ id: "install-a" }))

    // Both the installation and its version flip to "playing" while runGame is still pending.
    await waitFor(() => expect(readProbe().installationPlaying).toBe(true))
    expect(readProbe().gameVersionPlaying).toBe(true)

    resolveRun({ ok: true, exitCode: 0 })

    // ...and both clear again once the run resolves.
    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    expect(readProbe().gameVersionPlaying).toBe(false)

    const afterLaunch = Date.now()

    // Playtime is credited: a fresh lastTimePlayed timestamp, and totalTimePlayed
    // bumped up from the 100 it started at by no more than the run actually took.
    const probe = readProbe()
    expect(probe.lastTimePlayed).toBeGreaterThanOrEqual(beforeLaunch)
    expect(probe.lastTimePlayed).toBeLessThanOrEqual(afterLaunch)
    expect(probe.totalTimePlayed).toBeGreaterThanOrEqual(100)
    expect(probe.totalTimePlayed).toBeLessThanOrEqual(100 + (afterLaunch - beforeLaunch))

    expect(screen.queryByText("Vintage Story exited with errors!")).toBeNull()
  })

  it("still records playtime on a nonzero exit code, but also shows the exited-with-errors notice", async () => {
    const user = userEvent.setup()

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            lastUsedInstallation: "install-a",
            installations: [anInstallation()],
            gameVersions: [aGameVersion()]
          })
        )
      },
      gameManager: { executeGame: vi.fn(async () => ({ ok: true, exitCode: 1 }) as GameExecutionResult) }
    })

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText("Vintage Story exited with errors!")

    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    // ok: true still means the game ran, so it is still worth crediting the playtime.
    expect(readProbe().lastTimePlayed).toBeGreaterThan(-1)
  })

  const REFUSAL_CASES: { reason: GameExecutionFailureReason; message: string }[] = [
    { reason: "unsupported-platform", message: "Vintage Story can't run on this platform yet. Try it from Windows or Linux!" },
    { reason: "no-executable", message: "Couldn't find Vintage Story in this version's folder. Try reinstalling it!" },
    { reason: "session-write-failed", message: "Couldn't save your login to this installation. Try logging in again!" },
    { reason: "invalid-request", message: "This installation's environment variables can't be used. Check them and try again!" },
    { reason: "launch-failed", message: "An error has occurred while executing the game!" }
  ]

  it.each(REFUSAL_CASES)("shows the right notice for an ok:false/$reason refusal, records no playtime, and clears _playing", async ({ reason, message }) => {
    const user = userEvent.setup()

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            lastUsedInstallation: "install-a",
            installations: [anInstallation()],
            gameVersions: [aGameVersion()]
          })
        )
      },
      gameManager: { executeGame: vi.fn(async () => ({ ok: false, reason }) as GameExecutionResult) }
    })

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText(message)

    const probe = readProbe()
    expect(probe.lastTimePlayed).toBe(-1)
    expect(probe.totalTimePlayed).toBe(0)
    expect(probe.installationPlaying).toBe(false)
    expect(probe.gameVersionPlaying).toBe(false)
  })

  it("logs and notifies when executeGame itself throws, and still clears _playing (issue #40's finally guard)", async () => {
    const user = userEvent.setup()
    const logMessage = vi.fn()

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            lastUsedInstallation: "install-a",
            installations: [anInstallation()],
            gameVersions: [aGameVersion()]
          })
        )
      },
      utils: { logMessage },
      gameManager: {
        executeGame: vi.fn(async () => {
          throw new Error("boom")
        })
      }
    })

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText("An error has occurred while executing the game!")

    expect(logMessage).toHaveBeenCalledWith("error", expect.stringContaining("Error executing the game."))
    expect(logMessage).toHaveBeenCalledWith("debug", expect.stringContaining("boom"))

    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    expect(readProbe().gameVersionPlaying).toBe(false)
  })

  it("blocks the launch when the auto-backup fails, never calling executeGame, and still clears _playing (PR #42's finally guard)", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn()

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            backupsFolder: "/backups",
            lastUsedInstallation: "install-a",
            installations: [anInstallation({ backupsAuto: true })],
            gameVersions: [aGameVersion()]
          })
        )
      },
      // The installation "exists" on disk, so the backup service gets past its
      // path-missing guard and all the way to compressing -- where it is left
      // to fail, since compressOnPath is not mocked here (see windowApi.ts's
      // notMocked default), landing on the blocking "compress-failed" reason.
      pathsManager: { checkPathExists: vi.fn(async () => true) },
      gameManager: { executeGame }
    })

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText("There was an error making a backup!")

    expect(executeGame).not.toHaveBeenCalled()
    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    expect(readProbe().gameVersionPlaying).toBe(false)
  })
})

describe("MainMenu quick-backup button", () => {
  it("checks the installation path before backing up, and refuses without ever compressing when it is missing", async () => {
    const user = userEvent.setup()
    const checkPathExists = vi.fn(async () => false)
    const compressOnPath = vi.fn()

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            lastUsedInstallation: "install-a",
            installations: [anInstallation()],
            gameVersions: [aGameVersion()]
          })
        )
      },
      pathsManager: { checkPathExists, compressOnPath }
    })

    renderMainMenu()
    await user.click(await screen.findByTitle("Backup Installation"))

    await screen.findByText("This Installation has no data, please, play on it at least one time to generate the base data!")

    expect(checkPathExists).toHaveBeenCalledWith("/games/a")
    expect(compressOnPath).not.toHaveBeenCalled()
  })
})
