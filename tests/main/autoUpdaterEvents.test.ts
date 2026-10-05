import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Logger from "electron-log"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { createUpdaterLogger } from "@src/utils/updaterLogger"

/**
 * src/main/autoUpdaterEvents.ts: the main-to-renderer half of the launcher's
 * update flow, lifted out of main/index.ts so the properties issues #184 and
 * #185 are about can be asserted without launching Electron.
 *
 * The property under test that used to be impossible to state at all is the
 * negative one: finding an update must download nothing. Before this, finding
 * an update WAS downloading it (autoDownload defaults to true and nothing
 * turned it off), which is exactly what shipped in beta.2.
 */
const mockState = vi.hoisted(() => {
  const state = {
    userDataDir: "",
    updaterListeners: new Map<string, (payload?: unknown) => void>(),
    onListeners: new Map<string, (...args: unknown[]) => void>(),
    autoUpdater: { autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, logger: null as unknown } as {
      autoDownload: boolean
      autoInstallOnAppQuit: boolean
      allowPrerelease: boolean
      logger: unknown
    },
    downloadUpdate: vi.fn(() => Promise.resolve([] as string[])),
    quitAndInstall: vi.fn(),
    /** What allowPrerelease was at the moment each check went out, which is the only moment it matters. */
    allowPrereleaseWhenChecked: [] as boolean[],
    checkForUpdates: vi.fn((): Promise<unknown> => Promise.resolve(null))
  }

  state.checkForUpdates = vi.fn((): Promise<unknown> => {
    state.allowPrereleaseWhenChecked.push(state.autoUpdater.allowPrerelease)
    return Promise.resolve(null)
  })

  return state
})

vi.mock("electron", () => {
  const app = {
    getPath: (): string => mockState.userDataDir,
    getAppPath: (): string => mockState.userDataDir,
    isPackaged: false,
    name: "RiftLauncher",
    getName: (): string => "RiftLauncher",
    getVersion: (): string => "0.0.0-test",
    isReady: (): boolean => true,
    on: (): void => {},
    off: (): void => {},
    once: (): void => {}
  }

  const ipcMain = {
    handle: (): void => {},
    on: (channel: string, listener: (...args: unknown[]) => void): void => {
      mockState.onListeners.set(channel, listener)
    }
  }

  return { app, ipcMain }
})

// Shaped like the real package: no named `autoUpdater` export node's own ESM interop can see,
// only a `default` carrying it behind a getter (see src/utils/autoUpdaterLoader.ts's comment on
// why). A mock returning `{ autoUpdater: ... }` directly would let a reverted loader pass every
// test in this file while still throwing in the packaged app.
vi.mock("electron-updater", () => ({
  // Declared (as undefined) rather than left off entirely: vitest's mocked module namespace
  // throws on a property access it was never told about, where node's real interop would just
  // hand back `undefined`. Declaring it is what lets `namespace.autoUpdater` behave like the
  // real absent export the loader's `??` fallback is written for.
  autoUpdater: undefined,
  default: {
    get autoUpdater(): typeof mockState.autoUpdater {
      return Object.assign(mockState.autoUpdater, {
        on: (event: string, listener: (payload?: unknown) => void): unknown => {
          mockState.updaterListeners.set(event, listener)
          return mockState.autoUpdater
        },
        downloadUpdate: mockState.downloadUpdate,
        quitAndInstall: mockState.quitAndInstall,
        checkForUpdates: mockState.checkForUpdates
      })
    }
  }
}))

// The double the vi.mock above installs, reached the same way the real interop leaves it to be
// reached: no named export, only default.autoUpdater. Both functions take the updater as an
// argument now, so this is the same handing-in main/index.ts does once loadAutoUpdater has resolved.
import electronUpdaterModule from "electron-updater"

const autoUpdater = electronUpdaterModule.autoUpdater

import { registerAutoUpdaterEvents, scheduleUpdateCheck, toTaskProgress } from "@src/main/autoUpdaterEvents"
// Registers the renderer-facing half of the same flow (DOWNLOAD_UPDATE,
// UPDATE_AND_RESTART), so the handshake can be followed end to end: an offer
// the user accepts has to reach downloadUpdate, and one they never see must not.
import "@src/ipc/handlers/appUpdaterHandlers"
import { createTrustedEvent } from "../ipc/helpers/trustedEvent"

type SentMessage = { channel: string; payload?: unknown }

/** Fires one updater event, failing loudly if nothing ever subscribed to it. */
function emit(event: string, payload?: unknown): void {
  const listener = mockState.updaterListeners.get(event)
  if (!listener) throw new Error(`registerAutoUpdaterEvents never subscribed to "${event}"`)
  listener(payload)
}

/** Sends one renderer-to-main channel as the trusted renderer would. */
async function sendFromRenderer(channel: string): Promise<void> {
  const listener = mockState.onListeners.get(channel)
  if (!listener) throw new Error(`No ipcMain.on registered for "${channel}". Did the handler module get imported?`)
  listener(await createTrustedEvent())
  // The handler reaches electron-updater through loadAutoUpdater's dynamic import now, so the
  // call it makes lands a turn after this send. Draining the queue keeps the assertions below
  // the plain synchronous reads they have always been.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

let temporaryRoot: string
let sent: SentMessage[]

beforeEach(() => {
  vi.clearAllMocks()
  mockState.updaterListeners.clear()
  mockState.autoUpdater.autoDownload = true
  mockState.autoUpdater.autoInstallOnAppQuit = true
  mockState.autoUpdater.allowPrerelease = false
  mockState.autoUpdater.logger = null
  mockState.allowPrereleaseWhenChecked.length = 0
  temporaryRoot = mkdtempSync(join(tmpdir(), "auto-updater-events-"))
  mockState.userDataDir = join(temporaryRoot, "userData")

  sent = []
  registerAutoUpdaterEvents(autoUpdater, (channel, payload) => sent.push({ channel, payload }))
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

describe("consent (#184)", () => {
  it("turns automatic downloading off", () => {
    assert.equal(mockState.autoUpdater.autoDownload, false)
  })

  it("does not download when an update is found, it only tells the renderer about it", () => {
    emit("update-available", { version: "1.7.0-beta.3" })

    assert.equal(mockState.downloadUpdate.mock.calls.length, 0)
    assert.deepEqual(sent, [{ channel: IPC_CHANNELS.APP_UPDATER.UPDATE_AVAILABLE, payload: { version: "1.7.0-beta.3", releaseName: undefined } }])
  })

  it("passes the release name along when the feed carries one", () => {
    emit("update-available", { version: "1.7.0-beta.3", releaseName: "Beta 3" })

    assert.deepEqual(sent[0]?.payload, { version: "1.7.0-beta.3", releaseName: "Beta 3" })
  })

  it("drops a release name that is not a string rather than forwarding it", () => {
    emit("update-available", { version: "1.7.0-beta.3", releaseName: { note: "html blob" } })

    assert.deepEqual(sent[0]?.payload, { version: "1.7.0-beta.3", releaseName: undefined })
  })

  it("survives an update-available with no version at all", () => {
    emit("update-available", {})

    assert.deepEqual(sent[0]?.payload, { version: "", releaseName: undefined })
  })
})

describe("progress (#185)", () => {
  it("forwards each tick as a whole percentage, named with the version being offered", () => {
    emit("update-available", { version: "1.7.0-beta.3" })
    emit("download-progress", { percent: 42.7 })

    assert.deepEqual(sent[1], { channel: IPC_CHANNELS.APP_UPDATER.UPDATE_DOWNLOAD_PROGRESS, payload: { version: "1.7.0-beta.3", progress: 43 } })
  })

  it("forwards a progress tick that arrives with no percent as zero", () => {
    emit("update-available", { version: "1.7.0-beta.3" })
    emit("download-progress", {})

    assert.deepEqual(sent[1]?.payload, { version: "1.7.0-beta.3", progress: 0 })
  })

  it("completes by telling the renderer the update is downloaded", () => {
    emit("update-available", { version: "1.7.0-beta.3" })
    emit("download-progress", { percent: 99.4 })
    emit("update-downloaded", { version: "1.7.0-beta.3" })

    assert.deepEqual(
      sent.map((message) => message.channel),
      [IPC_CHANNELS.APP_UPDATER.UPDATE_AVAILABLE, IPC_CHANNELS.APP_UPDATER.UPDATE_DOWNLOAD_PROGRESS, IPC_CHANNELS.APP_UPDATER.UPDATE_DOWNLOADED]
    )
  })

  it("forwards an updater error so a half-finished bar has something to end on", () => {
    emit("error", new Error("connection reset"))

    assert.deepEqual(sent, [{ channel: IPC_CHANNELS.APP_UPDATER.UPDATE_ERROR, payload: undefined }])
  })
})

/**
 * The two ends joined up. Both cases lean on flags that only ever go one way
 * per process, so they are written as one run each rather than as a matrix;
 * tests/ipc/appUpdaterHandlers.test.ts re-imports the handler module per case
 * to cover the refusals those flags are there for.
 */
describe("the handshake, end to end", () => {
  it("downloads nothing until the renderer accepts, then downloads once", async () => {
    emit("update-available", { version: "1.7.0-beta.3" })
    assert.equal(mockState.downloadUpdate.mock.calls.length, 0)

    await sendFromRenderer(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE)

    assert.equal(mockState.downloadUpdate.mock.calls.length, 1)
  })

  it("sends the initial zero-progress message through the real renderer handshake", async () => {
    emit("error", new Error("reset before isolated handshake"))
    sent.length = 0
    emit("update-available", { version: "1.7.0-beta.3" })

    await sendFromRenderer(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE)

    assert.deepEqual(sent[1], {
      channel: IPC_CHANNELS.APP_UPDATER.UPDATE_DOWNLOAD_PROGRESS,
      payload: { version: "1.7.0-beta.3", progress: 0 }
    })
    assert.equal(mockState.downloadUpdate.mock.calls.length, 1)
  })

  it("lets a failed download be accepted a second time in the same session", async () => {
    emit("update-available", { version: "1.7.0-beta.3" })

    await sendFromRenderer(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE)
    const beforeTheFailure = mockState.downloadUpdate.mock.calls.length

    // The re-entrancy guard is still set here, so this one is refused. That is
    // the guard doing its job, and it is also what left a failed download with
    // nowhere to go before the error event started clearing it.
    await sendFromRenderer(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE)
    assert.equal(mockState.downloadUpdate.mock.calls.length, beforeTheFailure)

    emit("error", new Error("connection reset"))
    await sendFromRenderer(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE)

    assert.equal(mockState.downloadUpdate.mock.calls.length, beforeTheFailure + 1)
  })

  it("lets the renderer restart into the update once it has been downloaded", async () => {
    emit("update-downloaded", { version: "1.7.0-beta.3" })

    await sendFromRenderer(IPC_CHANNELS.APP_UPDATER.UPDATE_AND_RESTART)

    assert.deepEqual(mockState.quitAndInstall.mock.calls[0], [false, true])
  })
})

/**
 * Who installs a finished download (#648).
 *
 * electron-updater's autoInstallOnAppQuit defaults to true. With it on, the first finished download
 * hooks the app's quit event and runs the installer silently the next time the launcher closes,
 * whatever the player did with the "ready" toast, so someone who closed that toast and then the
 * window started their next session on a version they never chose. electron-updater reads the flag
 * in two places, when a download finishes and again when the app quits, and both reads are inside
 * the package, which a double cannot reach. What this file can pin is what it hands the updater:
 * the flag is off from registration on, and nothing in the event flow turns it back on.
 */
describe("installing a finished download (#648)", () => {
  it("turns installing on quit off, so only the restart button installs", () => {
    assert.equal(mockState.autoUpdater.autoInstallOnAppQuit, false)
  })

  it("keeps it off through a whole download, which is when electron-updater looks at it", () => {
    emit("update-available", { version: "1.7.0-beta.3" })
    emit("download-progress", { percent: 100 })
    emit("update-downloaded", { version: "1.7.0-beta.3" })

    assert.equal(mockState.autoUpdater.autoInstallOnAppQuit, false)
  })
})

/**
 * When the beta preference is read.
 *
 * It used to be read where the timer was armed, which meant a player who changed the setting while
 * the launcher was starting up got the answer they had before, with nothing on screen saying the
 * change waited for a relaunch. Reading it in the callback is what makes the toggle mean something
 * the same session.
 */
describe("scheduling the update check", () => {
  it("reads the preference when the check fires, not when it was armed", async () => {
    let allowPrerelease = false
    scheduleUpdateCheck(autoUpdater, async () => allowPrerelease, 1)

    // Arming touches nothing: this is still whatever electron-updater was left with.
    assert.equal(mockState.autoUpdater.allowPrerelease, false)

    // The player asks for betas while the launcher is still counting down to its check.
    allowPrerelease = true

    await vi.waitFor(() => assert.equal(mockState.checkForUpdates.mock.calls.length, 1))
    assert.deepEqual(mockState.allowPrereleaseWhenChecked, [true])
  })

  it("carries an opt-out made in the same window through to the check", async () => {
    let allowPrerelease = true
    scheduleUpdateCheck(autoUpdater, async () => allowPrerelease, 1)
    allowPrerelease = false

    await vi.waitFor(() => assert.equal(mockState.checkForUpdates.mock.calls.length, 1))
    assert.deepEqual(mockState.allowPrereleaseWhenChecked, [false])
  })

  it("swallows a check that fails, the ordinary case of launching with no network", async () => {
    mockState.checkForUpdates.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"))

    scheduleUpdateCheck(autoUpdater, async () => true, 1)

    await vi.waitFor(() => assert.equal(mockState.checkForUpdates.mock.calls.length, 1))
    assert.equal(mockState.autoUpdater.allowPrerelease, true)
  })
})

/**
 * What a failed update check leaves in the log (#650).
 *
 * electron-updater reports a failed check itself, before the promise rejects: its constructor
 * listens to its own "error" event and writes `Error: ${error.stack}` at error level through
 * whatever logger is installed at that moment (AppUpdater.js). With the GitHub provider the message
 * is a first line naming the reason followed by the whole releases feed, and the check's caller used
 * to log it a second time at info level. So one failed check left two lines in the log files, each
 * carrying the feed, one of them in error.log. tests/main/updateCheckFailureLog.test.ts holds the
 * same flow against the real package; the double below only has to fail the way the package does.
 */
describe("a failed update check in the log (#650)", () => {
  const REASON = "Cannot parse releases feed: Error: Unable to find latest version on GitHub, please ensure a production release exists: HttpError: 406 Not Acceptable"
  const FEED = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">${"<entry><title>A release</title></entry>".repeat(3_000)}</feed>`
  const CHECK_PREFIX = "[back] [autoUpdaterEvents] [main/autoUpdaterEvents.ts] [scheduleUpdateCheck]"
  const UPDATER_PREFIX = "[back] [index] [utils/updaterLogger.ts] [autoUpdater]"

  type LogLine = { level: "error" | "warn" | "info" | "debug"; text: string }

  /** Runs `attempt` and hands back every line that reached electron-log while it ran, after logManager's own redaction. */
  async function logLinesDuring(attempt: (lines: LogLine[]) => Promise<void>): Promise<LogLine[]> {
    const lines: LogLine[] = []
    const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
      vi.spyOn(Logger, level).mockImplementation((...params: unknown[]) => {
        lines.push({ level, text: String(params[0]) })
      })
    )

    try {
      await attempt(lines)
      return lines
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  }

  /**
   * The next check fails the way electron-updater's does: it says it is checking, then writes the
   * failure through the logger in place at that moment, then rejects.
   */
  function failTheNextCheck(failure: unknown): void {
    mockState.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdater.logger?.info("Checking for update")
      autoUpdater.logger?.error(`Error: ${failure instanceof Error ? failure.stack : String(failure)}`)
      throw failure
    })
  }

  /** Arms the check, waits for the updater to be asked, then for whatever reports its failure to have run. */
  async function runTheScheduledCheck(): Promise<void> {
    scheduleUpdateCheck(autoUpdater, async () => false, 1)

    await vi.waitFor(() => assert.equal(mockState.checkForUpdates.mock.calls.length, 1))
    await Promise.resolve(mockState.checkForUpdates.mock.results[0]?.value).catch(() => undefined)
    // The catch that reports the failure runs a few microtasks after the promise settles.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    autoUpdater.logger = createUpdaterLogger()
  })

  it("is one warn line holding only the reason, not the feed that follows it", async () => {
    failTheNextCheck(new Error(`${REASON}\n${FEED}`))

    const lines = await logLinesDuring(runTheScheduledCheck)

    assert.deepEqual(
      lines.filter((line) => line.level === "warn").map((line) => line.text),
      [`${CHECK_PREFIX} Update check failed: ${REASON}.`]
    )
    assert.deepEqual(
      lines.filter((line) => line.level === "error").map((line) => line.text.length),
      [],
      "the updater's own record of the failure reached error.log"
    )
    assert.deepEqual(
      lines.filter((line) => line.text.length > 1_000).map((line) => `${line.level}: ${line.text.length} characters`),
      [],
      "a line carries more than the reason"
    )
  })

  it("cuts at a Windows line break too", async () => {
    failTheNextCheck(new Error(`${REASON}\r\n${FEED}`))

    const lines = await logLinesDuring(runTheScheduledCheck)

    assert.deepEqual(
      lines.filter((line) => line.level === "warn").map((line) => line.text),
      [`${CHECK_PREFIX} Update check failed: ${REASON}.`]
    )
  })

  it("reports a rejection that is not an Error by its text", async () => {
    failTheNextCheck("offline")

    const lines = await logLinesDuring(runTheScheduledCheck)

    assert.deepEqual(
      lines.filter((line) => line.level === "warn").map((line) => line.text),
      [`${CHECK_PREFIX} Update check failed: offline.`]
    )
  })

  it("still reports a check that could not start, which the updater never heard of", async () => {
    const lines = await logLinesDuring(async (recorded) => {
      scheduleUpdateCheck(autoUpdater, () => Promise.reject(new Error("settings unreadable")), 1)
      await vi.waitFor(() => assert.equal(recorded.length, 1))
    })

    assert.equal(mockState.checkForUpdates.mock.calls.length, 0)
    assert.deepEqual(lines, [{ level: "warn", text: `${CHECK_PREFIX} Update check failed: settings unreadable.` }])
  })

  it("mutes only the updater's error level while the check runs, and puts its logger back", async () => {
    const logger = createUpdaterLogger()
    autoUpdater.logger = logger
    mockState.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdater.logger?.info("Checking for update")
      autoUpdater.logger?.warn("Cannot compare versions")
      autoUpdater.logger?.debug?.("Provider answered")
      autoUpdater.logger?.error("Error: offline")
      throw new Error("offline")
    })

    const lines = await logLinesDuring(async () => {
      await runTheScheduledCheck()
      // Not part of any check: this one is still the updater's to record.
      autoUpdater.logger?.error("download failed")
    })

    assert.equal(autoUpdater.logger, logger)
    assert.deepEqual(lines, [
      { level: "info", text: `${UPDATER_PREFIX} Checking for update` },
      { level: "warn", text: `${UPDATER_PREFIX} Cannot compare versions` },
      { level: "debug", text: `${UPDATER_PREFIX} Provider answered` },
      { level: "warn", text: `${CHECK_PREFIX} Update check failed: offline.` },
      { level: "error", text: `${UPDATER_PREFIX} download failed` }
    ])
  })

  it("puts the updater's logger back after a check that succeeds too", async () => {
    const logger = createUpdaterLogger()
    autoUpdater.logger = logger

    await logLinesDuring(runTheScheduledCheck)

    assert.equal(autoUpdater.logger, logger)
  })
})

describe("toTaskProgress", () => {
  it("rounds to a whole percentage", () => {
    assert.equal(toTaskProgress(0.4), 0)
    assert.equal(toTaskProgress(42.5), 43)
    assert.equal(toTaskProgress(99.6), 100)
  })

  it("clamps anything outside 0 to 100", () => {
    assert.equal(toTaskProgress(-5), 0)
    assert.equal(toTaskProgress(140), 100)
  })

  it("treats a value that is not a number as no progress", () => {
    assert.equal(toTaskProgress(Number.NaN), 0)
    assert.equal(toTaskProgress(Number.POSITIVE_INFINITY), 0)
  })
})
