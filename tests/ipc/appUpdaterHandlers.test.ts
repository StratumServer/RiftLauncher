import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainEvent } from "electron"

import { createTrustedEvent, createUntrustedEvent } from "./helpers/trustedEvent"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * The trust and consent boundary of src/ipc/handlers/appUpdaterHandlers.ts,
 * which had no test of its own before issue #184 gave it a second channel.
 *
 * Both channels here are `ipcMain.on`, not `ipcMain.handle`, so the shared
 * tests/ipc/helpers/electronMock (which only captures `handle`) cannot serve
 * them; this file brings its own `electron` mock, the same way
 * tests/ipc/utilsHandlers.test.ts does and for the same reason. `electron-updater`
 * is mocked too, since `downloadUpdate`/`quitAndInstall` are precisely what
 * must not run.
 *
 * The updater double is built once, in `vi.hoisted`, and reused across every
 * `vi.resetModules()`: each test needs a handler module whose one-way flags
 * (updateAvailable, updateDownloaded, updateDownloadStarted) start out unset,
 * but the assertions have to keep pointing at the same `vi.fn`s the re-imported
 * module ends up calling.
 */
const mockState = vi.hoisted(() => ({
  userDataDir: "",
  onListeners: new Map<string, (...args: unknown[]) => void>(),
  downloadUpdate: vi.fn(() => Promise.resolve([] as string[])),
  quitAndInstall: vi.fn()
}))

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
  autoUpdater: {
    autoDownload: true,
    downloadUpdate: mockState.downloadUpdate,
    quitAndInstall: mockState.quitAndInstall,
    on: (): void => {}
  }
}))

type UpdaterHandlers = typeof import("@src/ipc/handlers/appUpdaterHandlers")

/** Re-imports the handler module with its module-level flags back to their initial, unset state. */
async function loadHandlers(): Promise<UpdaterHandlers> {
  vi.resetModules()
  mockState.onListeners.clear()
  return import("@src/ipc/handlers/appUpdaterHandlers")
}

function send(channel: string, event: IpcMainEvent): void {
  const listener = mockState.onListeners.get(channel)
  if (!listener) throw new Error(`No ipcMain.on registered for "${channel}". Did the handler module get imported?`)
  listener(event)
}

let temporaryRoot: string

beforeEach(() => {
  vi.clearAllMocks()
  temporaryRoot = mkdtempSync(join(tmpdir(), "app-updater-handlers-"))
  mockState.userDataDir = join(temporaryRoot, "userData")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

describe("DOWNLOAD_UPDATE", () => {
  it("does not download for an untrusted sender, even once an update has been offered", async () => {
    const handlers = await loadHandlers()
    handlers.markUpdateAvailable()

    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, createUntrustedEvent() as unknown as IpcMainEvent)

    assert.equal(mockState.downloadUpdate.mock.calls.length, 0)
  })

  it("does not download for a trusted sender before any update has been offered", async () => {
    await loadHandlers()
    const event = (await createTrustedEvent()) as unknown as IpcMainEvent

    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)

    assert.equal(mockState.downloadUpdate.mock.calls.length, 0)
  })

  it("downloads for a trusted sender once an update has been offered", async () => {
    const handlers = await loadHandlers()
    handlers.markUpdateAvailable()
    const event = (await createTrustedEvent()) as unknown as IpcMainEvent

    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)

    assert.equal(mockState.downloadUpdate.mock.calls.length, 1)
  })

  it("downloads once, however many times the accepted channel is sent", async () => {
    const handlers = await loadHandlers()
    handlers.markUpdateAvailable()
    const event = (await createTrustedEvent()) as unknown as IpcMainEvent

    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)
    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)
    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)

    assert.equal(mockState.downloadUpdate.mock.calls.length, 1)
  })

  it("lets a later accept through once a failed download has been reset", async () => {
    const handlers = await loadHandlers()
    handlers.markUpdateAvailable()
    const event = (await createTrustedEvent()) as unknown as IpcMainEvent

    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)
    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)
    assert.equal(mockState.downloadUpdate.mock.calls.length, 1)

    // What the updater's error event calls, so the retry the renderer puts on
    // screen after a failed download is one the main process will honour.
    handlers.resetUpdateDownload()
    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)

    assert.equal(mockState.downloadUpdate.mock.calls.length, 2)
  })

  it("does not let a reset stand in for an offer that was never made", async () => {
    const handlers = await loadHandlers()
    handlers.resetUpdateDownload()
    const event = (await createTrustedEvent()) as unknown as IpcMainEvent

    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)

    assert.equal(mockState.downloadUpdate.mock.calls.length, 0)
  })

  it("lets a later accept through when the download itself failed", async () => {
    mockState.downloadUpdate.mockImplementationOnce(() => Promise.reject(new Error("connection reset")))

    const handlers = await loadHandlers()
    handlers.markUpdateAvailable()
    const event = (await createTrustedEvent()) as unknown as IpcMainEvent

    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)
    // The rejection is caught inside the handler; let that microtask land
    // before asking whether the guard was cleared again.
    await Promise.resolve()
    await Promise.resolve()

    send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE, event)

    assert.equal(mockState.downloadUpdate.mock.calls.length, 2)
  })
})

describe("UPDATE_AND_RESTART", () => {
  it("does not restart for an untrusted sender", async () => {
    const handlers = await loadHandlers()
    handlers.markUpdateDownloaded()

    send(IPC_CHANNELS.APP_UPDATER.UPDATE_AND_RESTART, createUntrustedEvent() as unknown as IpcMainEvent)

    assert.equal(mockState.quitAndInstall.mock.calls.length, 0)
  })

  it("does not restart for a trusted sender before anything has been downloaded", async () => {
    await loadHandlers()
    const event = (await createTrustedEvent()) as unknown as IpcMainEvent

    send(IPC_CHANNELS.APP_UPDATER.UPDATE_AND_RESTART, event)

    assert.equal(mockState.quitAndInstall.mock.calls.length, 0)
  })

  it("restarts for a trusted sender once the update is downloaded", async () => {
    const handlers = await loadHandlers()
    handlers.markUpdateDownloaded()
    const event = (await createTrustedEvent()) as unknown as IpcMainEvent

    send(IPC_CHANNELS.APP_UPDATER.UPDATE_AND_RESTART, event)

    assert.deepEqual(mockState.quitAndInstall.mock.calls[0], [false, true])
  })

  it("forgets the downloaded update when quitAndInstall throws, so a retry is refused rather than looping", async () => {
    mockState.quitAndInstall.mockImplementation(() => {
      throw new Error("installer missing")
    })

    const handlers = await loadHandlers()
    handlers.markUpdateDownloaded()
    const event = (await createTrustedEvent()) as unknown as IpcMainEvent

    send(IPC_CHANNELS.APP_UPDATER.UPDATE_AND_RESTART, event)
    send(IPC_CHANNELS.APP_UPDATER.UPDATE_AND_RESTART, event)

    assert.equal(mockState.quitAndInstall.mock.calls.length, 1)
  })
})
