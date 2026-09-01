import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

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
    autoUpdater: { autoDownload: true, allowPrerelease: false } as { autoDownload: boolean; allowPrerelease: boolean },
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

vi.mock("electron-updater", () => ({
  autoUpdater: Object.assign(mockState.autoUpdater, {
    on: (event: string, listener: (payload?: unknown) => void): unknown => {
      mockState.updaterListeners.set(event, listener)
      return mockState.autoUpdater
    },
    downloadUpdate: mockState.downloadUpdate,
    quitAndInstall: mockState.quitAndInstall,
    checkForUpdates: mockState.checkForUpdates
  })
}))

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
}

let temporaryRoot: string
let sent: SentMessage[]

beforeEach(() => {
  vi.clearAllMocks()
  mockState.updaterListeners.clear()
  mockState.autoUpdater.autoDownload = true
  mockState.autoUpdater.allowPrerelease = false
  mockState.allowPrereleaseWhenChecked.length = 0
  temporaryRoot = mkdtempSync(join(tmpdir(), "auto-updater-events-"))
  mockState.userDataDir = join(temporaryRoot, "userData")

  sent = []
  registerAutoUpdaterEvents((channel, payload) => sent.push({ channel, payload }))
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
    scheduleUpdateCheck(async () => allowPrerelease, 1)

    // Arming touches nothing: this is still whatever electron-updater was left with.
    assert.equal(mockState.autoUpdater.allowPrerelease, false)

    // The player asks for betas while the launcher is still counting down to its check.
    allowPrerelease = true

    await vi.waitFor(() => assert.equal(mockState.checkForUpdates.mock.calls.length, 1))
    assert.deepEqual(mockState.allowPrereleaseWhenChecked, [true])
  })

  it("carries an opt-out made in the same window through to the check", async () => {
    let allowPrerelease = true
    scheduleUpdateCheck(async () => allowPrerelease, 1)
    allowPrerelease = false

    await vi.waitFor(() => assert.equal(mockState.checkForUpdates.mock.calls.length, 1))
    assert.deepEqual(mockState.allowPrereleaseWhenChecked, [false])
  })

  it("swallows a check that fails, the ordinary case of launching with no network", async () => {
    mockState.checkForUpdates.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"))

    scheduleUpdateCheck(async () => true, 1)

    await vi.waitFor(() => assert.equal(mockState.checkForUpdates.mock.calls.length, 1))
    assert.equal(mockState.autoUpdater.allowPrerelease, true)
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
