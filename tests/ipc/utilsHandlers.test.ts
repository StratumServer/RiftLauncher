import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { platform as nodePlatform } from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import { getIpcHandler, registerIpcHandler } from "./helpers/ipcHandlerRegistry"
import { createTrustedEvent, createUntrustedEvent } from "./helpers/trustedEvent"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * Registry-pattern branch coverage for src/ipc/handlers/utilsHandlers.ts,
 * previously entirely unimported by a test (0%, 53 statements).
 *
 * This file gets its own `electron` mock rather than tests/ipc/helpers/electronMock
 * (the shared one every other handler test file uses): utilsHandlers.ts registers
 * three channels with `ipcMain.on` (LOG_MESSAGE, SET_PREVENT_APP_CLOSE,
 * OPEN_ON_BROWSER), which the shared mock has no capture for, and reaches
 * `dialog.showOpenDialog`/`shell.openExternal`, which it does not stub either.
 * `ipcHandlerRegistry`/`trustedEvent` are the mock-free halves of that shared
 * helper (see ipcHandlerRegistry.ts's own comment for why the split exists),
 * safe to reuse from a file with a differently-shaped `electron` mock -- the
 * same pattern tests/ipc/netHandlersDispatch.test.ts already uses for the
 * same reason (net.request there, ipcMain.on/dialog/shell here).
 *
 * Everything downstream of `electron` stays real: ipcSecurity.ts, validation.ts
 * (the OPEN_ON_BROWSER allow-list), shouldPreventClose.ts and pathPolicy.ts are
 * not mocked, so "refuses a URL outside the allow-list" and "adds/removes a
 * task blocking app close" mean what production means by them.
 */
const mockState = vi.hoisted(() => ({
  userDataDir: "",
  appVersion: "0.0.0-test",
  onListeners: new Map<string, (event: IpcMainInvokeEvent, ...args: never[]) => void>()
}))

vi.mock("electron", () => {
  const app = {
    getPath: (): string => mockState.userDataDir,
    getAppPath: (): string => mockState.userDataDir,
    isPackaged: false,
    name: "RiftLauncher",
    getName: (): string => "RiftLauncher",
    getVersion: (): string => mockState.appVersion,
    isReady: (): boolean => true,
    on: (): void => {},
    off: (): void => {},
    once: (): void => {}
  }

  const ipcMain = {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
      registerIpcHandler(channel, listener)
    },
    on: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => void): void => {
      mockState.onListeners.set(channel, listener)
    }
  }

  const dialog = { showOpenDialog: vi.fn() }
  const shell = { openExternal: vi.fn() }

  return { app, ipcMain, dialog, shell }
})

import "@src/ipc/handlers/utilsHandlers"
import { dialog, shell } from "electron"
import { getShouldPreventClose } from "@src/utils/shouldPreventClose"
import { isUserApprovedPath } from "@src/ipc/pathPolicy"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InvokeHandler<R = Promise<unknown>> = (event: IpcMainInvokeEvent, ...args: any[]) => R
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OnListener = (event: IpcMainInvokeEvent, ...args: any[]) => void

function handler<R = Promise<unknown>>(channel: string): InvokeHandler<R> {
  return getIpcHandler<InvokeHandler<R>>(channel)
}

function onListener(channel: string): OnListener {
  const listener = mockState.onListeners.get(channel)
  if (!listener) throw new Error(`No ipcMain.on registered for "${channel}". Did the handler module get imported?`)
  return listener as OnListener
}

let temporaryRoot: string

beforeEach(() => {
  // dialog.showOpenDialog/shell.openExternal are plain vi.fn()s from the
  // vi.mock("electron", ...) factory above, not vi.spyOn() spies, so
  // afterEach's vi.restoreAllMocks() does not touch their call history --
  // clear it explicitly or a later test sees an earlier test's calls.
  vi.clearAllMocks()
  temporaryRoot = mkdtempSync(join(tmpdir(), "utils-handlers-"))
  mockState.userDataDir = join(temporaryRoot, "userData")
  mockState.appVersion = "0.0.0-test"
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("GET_APP_VERSION", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", () => {
    assert.throws(() => handler(IPC_CHANNELS.UTILS.GET_APP_VERSION)(createUntrustedEvent()), /Unauthorized IPC sender/)
  })

  it("returns the app's version for a trusted caller", async () => {
    const event = await createTrustedEvent()
    assert.equal(handler<string>(IPC_CHANNELS.UTILS.GET_APP_VERSION)(event), "0.0.0-test")
  })
})

describe("GET_OS", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", () => {
    assert.throws(() => handler(IPC_CHANNELS.UTILS.GET_OS)(createUntrustedEvent()), /Unauthorized IPC sender/)
  })

  it("returns the host platform for a trusted caller", async () => {
    const event = await createTrustedEvent()
    assert.equal(handler<string>(IPC_CHANNELS.UTILS.GET_OS)(event), nodePlatform())
  })
})

describe("LOG_MESSAGE", () => {
  it("does nothing for an untrusted sender", () => {
    assert.doesNotThrow(() => onListener(IPC_CHANNELS.UTILS.LOG_MESSAGE)(createUntrustedEvent(), "info", "hello"))
  })

  it("does nothing for a mode outside the allow-list", async () => {
    const event = await createTrustedEvent()
    assert.doesNotThrow(() => onListener(IPC_CHANNELS.UTILS.LOG_MESSAGE)(event, "trace", "hello"))
  })

  it("logs every allowed mode without throwing", async () => {
    const event = await createTrustedEvent()
    for (const mode of ["error", "warn", "info", "debug", "verbose"]) {
      assert.doesNotThrow(() => onListener(IPC_CHANNELS.UTILS.LOG_MESSAGE)(event, mode, "hello"))
    }
  })

  it("falls back to a warning instead of throwing when the message itself is invalid", async () => {
    const event = await createTrustedEvent()
    // assertString refuses an embedded NUL byte, which is what routes this
    // call through the catch -> logMessage("warn", ...) fallback branch.
    assert.doesNotThrow(() => onListener(IPC_CHANNELS.UTILS.LOG_MESSAGE)(event, "info", "bad\0message"))
  })
})

describe("SET_PREVENT_APP_CLOSE", () => {
  it("does nothing for an untrusted sender", () => {
    onListener(IPC_CHANNELS.UTILS.SET_PREVENT_APP_CLOSE)(createUntrustedEvent(), "add", "task-untrusted", "desc")
    assert.equal(getShouldPreventClose(), false)
  })

  it("does nothing for an action outside add/remove", async () => {
    const event = await createTrustedEvent()
    onListener(IPC_CHANNELS.UTILS.SET_PREVENT_APP_CLOSE)(event, "toggle", "task-bad-action", "desc")
    assert.equal(getShouldPreventClose(), false)
  })

  it("adds a task blocking close, then removes it, letting close happen again", async () => {
    const event = await createTrustedEvent()
    onListener(IPC_CHANNELS.UTILS.SET_PREVENT_APP_CLOSE)(event, "add", "task-1", "Started something")
    assert.equal(getShouldPreventClose(), true)

    onListener(IPC_CHANNELS.UTILS.SET_PREVENT_APP_CLOSE)(event, "remove", "task-1", "Finished something")
    assert.equal(getShouldPreventClose(), false)
  })

  it("falls back to a warning instead of throwing when the task id is invalid", async () => {
    const event = await createTrustedEvent()
    assert.doesNotThrow(() => onListener(IPC_CHANNELS.UTILS.SET_PREVENT_APP_CLOSE)(event, "add", "bad id!", "desc"))
    assert.equal(getShouldPreventClose(), false)
  })
})

describe("OPEN_ON_BROWSER", () => {
  it("does nothing for an untrusted sender", () => {
    onListener(IPC_CHANNELS.UTILS.OPEN_ON_BROWSER)(createUntrustedEvent(), "https://github.com/StratumServer/RiftLauncher")
    assert.equal(vi.mocked(shell.openExternal).mock.calls.length, 0)
  })

  it("refuses a URL whose host is not on the allow-list, never calling openExternal", async () => {
    const event = await createTrustedEvent()
    onListener(IPC_CHANNELS.UTILS.OPEN_ON_BROWSER)(event, "https://evil.example.com/")
    assert.equal(vi.mocked(shell.openExternal).mock.calls.length, 0)
  })

  it("refuses a URL whose host is allow-listed but whose path is not, never calling openExternal", async () => {
    const event = await createTrustedEvent()
    onListener(IPC_CHANNELS.UTILS.OPEN_ON_BROWSER)(event, "https://github.com/some/other/repo")
    assert.equal(vi.mocked(shell.openExternal).mock.calls.length, 0)
  })

  it("opens an allow-listed URL on the default browser", async () => {
    vi.mocked(shell.openExternal).mockResolvedValueOnce(undefined)
    const event = await createTrustedEvent()
    const url = "https://github.com/StratumServer/RiftLauncher"
    onListener(IPC_CHANNELS.UTILS.OPEN_ON_BROWSER)(event, url)

    assert.equal(vi.mocked(shell.openExternal).mock.calls.length, 1)
    assert.equal(vi.mocked(shell.openExternal).mock.calls[0]?.[0], url)
  })

  it("swallows a rejection from the default browser instead of throwing", async () => {
    const rejection = Promise.reject(new Error("no default browser configured"))
    vi.mocked(shell.openExternal).mockReturnValueOnce(rejection)
    const event = await createTrustedEvent()

    onListener(IPC_CHANNELS.UTILS.OPEN_ON_BROWSER)(event, "https://github.com/StratumServer/RiftLauncher")

    // The handler's own .catch(() => {}) is attached synchronously before this
    // one, so awaiting the same promise here only resolves after that handler
    // has already run.
    await rejection.catch(() => {})
    assert.equal(vi.mocked(shell.openExternal).mock.calls.length, 1)
  })
})

describe("SELECT_FOLDER_DIALOG", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => handler(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG)(createUntrustedEvent()), /Unauthorized IPC sender/)
  })

  it("rejects options that are not a record", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG)(event, "bad"), /Invalid dialog options/)
  })

  it("rejects an invalid dialog type", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG)(event, { type: "bogus" }), /Invalid dialog type/)
  })

  it("rejects an invalid dialog mode", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG)(event, { mode: "bogus" }), /Invalid dialog mode/)
  })

  it("rejects invalid dialog extensions", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG)(event, { extensions: ["ok", "bad extension!"] }), /Invalid dialog extensions/)
  })

  it("rejects more than 16 extensions", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG)(event, { extensions: Array(17).fill("zip") }), /Invalid dialog extensions/)
  })

  it("returns an empty array when the user cancels, without approving any path", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const event = await createTrustedEvent()
    const result = await handler<Promise<string[]>>(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG)(event)
    assert.deepEqual(result, [])
  })

  it("defaults to a single folder-picker dialog with no options", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const event = await createTrustedEvent()
    await handler(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG)(event)

    const options = vi.mocked(dialog.showOpenDialog).mock.calls[0]?.[0]
    assert.deepEqual(options?.properties, ["openDirectory"])
  })

  it("returns the selected paths and registers them as approved for a multi file picker", async () => {
    const selected = [join(temporaryRoot, "a.zip"), join(temporaryRoot, "b.zip")]
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: selected })
    const event = await createTrustedEvent()

    const result = await handler<Promise<string[]>>(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG)(event, { type: "file", mode: "multi", extensions: ["zip"] })
    assert.deepEqual(result, selected)

    const options = vi.mocked(dialog.showOpenDialog).mock.calls[0]?.[0]
    assert.deepEqual(options?.properties, ["openFile", "multiSelections"])

    for (const path of selected) assert.equal(isUserApprovedPath(path), true)
  })
})
