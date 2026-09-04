import { afterEach, describe, expect, it, vi, type Mock } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import MainMenu from "@renderer/components/layout/MainMenu"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { useGameVersions, useInstallations } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Exercises src/renderer/src/features/launch/adapters/launch.ts through MainMenu's Play
 * button and its quick-backup icon, the only two call sites that file has. Nothing here
 * mocks the launch feature itself: window.api is the only seam,
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

const BACKUP_WRITE_FAILED = "No backup made: the backup archive could not be written. Check that the Backups folder is on a writable drive with free space."
const BACKUP_PRUNE_FAILED = "No backup made: an old backup could not be removed to make room for the new one."
const SKIP_PROMPT = "The backup failed. Launch without a backup this time?"

/**
 * A config whose auto-backup is guaranteed to fail for a blocking reason.
 *
 * The installation "exists" on disk, so the backup service gets past its
 * path-missing guard and all the way to compressing, where it is left to fail:
 * compressOnPath is not mocked (see windowApi.ts's notMocked default), landing
 * on the blocking "compress-failed" reason. The cause is not one of the
 * recognised compression kinds, so the notification is the write-failure sentence.
 */
function withFailingAutoBackup(executeGame: Mock): void {
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
    pathsManager: { checkPathExists: vi.fn(async () => true) },
    gameManager: { executeGame }
  })
}

function withPruneFailingAutoBackup(executeGame: Mock): void {
  installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () =>
        createMockConfig({
          backupsFolder: "/backups",
          lastUsedInstallation: "install-a",
          installations: [
            anInstallation({
              backupsAuto: true,
              backupsLimit: 1,
              backups: [{ id: "backup-1", date: 1, path: "/backups/backup-1.zip" }]
            })
          ],
          gameVersions: [aGameVersion()]
        })
      )
    },
    pathsManager: {
      checkPathExists: vi.fn(async () => true),
      deletePath: vi.fn(async () => false)
    },
    gameManager: { executeGame }
  })
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

  it("refuses to play an Installation with no VS Version set and names the state instead of a blank version", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn(async () => ({ ok: true, exitCode: 0 }) as GameExecutionResult)

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            lastUsedInstallation: "install-a",
            installations: [anInstallation({ version: "" })],
            gameVersions: [aGameVersion()]
          })
        )
      },
      gameManager: { executeGame }
    })

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText("This Installation has no VS Version set!")
    expect(executeGame).not.toHaveBeenCalled()
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

  it("asks before launching past a failed auto-backup, and Cancel keeps the launch blocked", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn()
    withFailingAutoBackup(executeGame)

    renderMainMenu()
    await clickPlay(user)

    // The specific cause reaches the player through the notification, as of #345.
    await screen.findByText(BACKUP_WRITE_FAILED)

    // The question itself is the launcher's own dialog, not the OS one: a
    // labelled dialog jsdom can drive, which window.confirm could not.
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(SKIP_PROMPT)).toBeTruthy()
    expect(within(dialog).getByText("Backup failed")).toBeTruthy()

    // The internal reason token never reaches the player (#338 review).
    expect(screen.queryByText(/compress-failed/)).toBeNull()

    // Cancel is first in the DOM, so the focus trap lands on it (or on the
    // panel), never on Launch anyway: a stray Enter cannot skip the backup.
    const buttons = within(dialog).getAllByRole("button")
    expect(buttons[0]).toBe(within(dialog).getByTitle("Cancel"))

    await user.click(within(dialog).getByTitle("Cancel"))

    expect(executeGame).not.toHaveBeenCalled()
    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    expect(readProbe().gameVersionPlaying).toBe(false)
  })

  it("treats dismissing the prompt as a refusal, not as consent to launch", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn()
    withFailingAutoBackup(executeGame)

    renderMainMenu()
    await clickPlay(user)
    await screen.findByText(SKIP_PROMPT)

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByText(SKIP_PROMPT)).toBeNull())
    expect(executeGame).not.toHaveBeenCalled()
    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    expect(readProbe().gameVersionPlaying).toBe(false)
  })

  it("launches twice only after answering each failed-backup prompt", async () => {
    const user = userEvent.setup()
    let resolveFirstRun!: (result: GameExecutionResult) => void
    let resolveSecondRun!: (result: GameExecutionResult) => void
    const firstRun = new Promise<GameExecutionResult>((resolve) => {
      resolveFirstRun = resolve
    })
    const secondRun = new Promise<GameExecutionResult>((resolve) => {
      resolveSecondRun = resolve
    })
    const executeGame = vi.fn().mockReturnValueOnce(firstRun).mockReturnValueOnce(secondRun)
    withFailingAutoBackup(executeGame)

    renderMainMenu()
    await clickPlay(user)
    await screen.findByText(SKIP_PROMPT)

    await user.click(within(await screen.findByRole("dialog")).getByTitle("Launch anyway"))

    await waitFor(() => expect(executeGame).toHaveBeenCalledTimes(1))
    resolveFirstRun({ ok: true, exitCode: 0 })
    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    expect(readProbe().gameVersionPlaying).toBe(false)

    await clickPlay(user)
    await screen.findByText(SKIP_PROMPT)
    expect(executeGame).toHaveBeenCalledTimes(1)

    await user.click(within(await screen.findByRole("dialog")).getByTitle("Launch anyway"))

    await waitFor(() => expect(executeGame).toHaveBeenCalledTimes(2))
    resolveSecondRun({ ok: true, exitCode: 0 })
    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    expect(readProbe().gameVersionPlaying).toBe(false)
  })

  it("asks again on the next launch: the answer is for this launch only, never remembered", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn()
    withFailingAutoBackup(executeGame)

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText(SKIP_PROMPT)
    await user.click(within(await screen.findByRole("dialog")).getByTitle("Cancel"))

    // The dialog's exit animation keeps it, and the inert attribute it puts on
    // the rest of the page, mounted for a moment after the click, so the Play
    // button is only reachable again once it has gone.
    await waitFor(() => expect(screen.queryByText(SKIP_PROMPT)).toBeNull())

    await clickPlay(user)

    expect(await screen.findByText(SKIP_PROMPT)).toBeTruthy()
    expect(executeGame).not.toHaveBeenCalled()
  })

  it("launches with no question at all when the auto-backup stops for a non-blocking reason", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn(async () => ({ ok: true, exitCode: 0 }) as GameExecutionResult)

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            // No backups folder set: the backup stops on "no-backups-folder",
            // one of the three reasons that mean there was nothing to back up.
            backupsFolder: "",
            lastUsedInstallation: "install-a",
            installations: [anInstallation({ backupsAuto: true })],
            gameVersions: [aGameVersion()]
          })
        )
      },
      pathsManager: { checkPathExists: vi.fn(async () => true) },
      gameManager: { executeGame }
    })

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText("No backup made: you haven't set a Backups folder. Set one on the Config page.")

    await waitFor(() => expect(executeGame).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("blocks a non-recoverable auto-backup failure without offering an override", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn()

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            backupsFolder: "/backups",
            lastUsedInstallation: "install-a",
            installations: [anInstallation({ backupsAuto: true, _backuping: true })],
            gameVersions: [aGameVersion()]
          })
        )
      },
      gameManager: { executeGame }
    })

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText("There is a backup already in progress!")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(executeGame).not.toHaveBeenCalled()
    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    expect(readProbe().gameVersionPlaying).toBe(false)
  })

  it("blocks an auto-backup while the installation is restoring without offering an override", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn()

    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            backupsFolder: "/backups",
            lastUsedInstallation: "install-a",
            installations: [anInstallation({ backupsAuto: true, _restoringBackup: true })],
            gameVersions: [aGameVersion()]
          })
        )
      },
      gameManager: { executeGame }
    })

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText("There's a Backup restoration already in progress!")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(executeGame).not.toHaveBeenCalled()
    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    expect(readProbe().gameVersionPlaying).toBe(false)
  })

  it("offers the override for a failed backup prune", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn(async () => ({ ok: true, exitCode: 0 }) as GameExecutionResult)
    withPruneFailingAutoBackup(executeGame)

    renderMainMenu()
    await clickPlay(user)

    await screen.findByText(BACKUP_PRUNE_FAILED)
    expect(await screen.findByRole("dialog")).toBeTruthy()

    await user.click(within(await screen.findByRole("dialog")).getByTitle("Launch anyway"))

    await waitFor(() => expect(executeGame).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(readProbe().installationPlaying).toBe(false))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
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
