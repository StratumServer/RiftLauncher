import { vi } from "vitest"
import type { IpcMainInvokeEvent } from "electron"

import { registerIpcHandler } from "./ipcHandlerRegistry"

export { getIpcHandler } from "./ipcHandlerRegistry"
export { createTrustedEvent, createUntrustedEvent } from "./trustedEvent"

/**
 * Mutable per-test state the mock reads from at call time. Tests set the
 * userData path in `beforeEach`, once they have made a fresh temp directory, so
 * `app.getPath("userData")` always points somewhere private to the running test
 * rather than to a value baked in when the mock factory ran.
 *
 * `namedPaths` backs the other names `app.getPath`/`app.getAppPath` can be
 * asked for (`appData`, `home`, the app root). Handler tests that reach
 * pathPolicy.ts or configManager.ts need those to be distinguishable folders;
 * everything else keeps the original behavior of collapsing every name onto
 * `userDataPath`, which is what electron-log's own calls rely on.
 */
const state = { userDataPath: "" }
const namedPaths: Record<string, string> = {}

/**
 * Listeners handed to `app.on(event, listener)`, keyed by event name. Real enough to let a
 * test fire the same `before-quit` event both `workerManager.ts` and
 * `ipc/handlers/pathsHandlers.ts` register a listener for at module load, and see both
 * fire, the same as a real Electron quit would trigger every registered handler.
 */
const appEventListeners = new Map<string, Array<(...args: unknown[]) => void>>()

/** Invokes every listener registered for `event` via `app.on`, in registration order. */
export function emitAppEvent(event: string, ...args: unknown[]): void {
  for (const listener of appEventListeners.get(event) ?? []) listener(...args)
}

/** Drops every recorded `app.on` listener. Call in `beforeEach`, before the module under test re-registers its own. */
export function clearAppEventListeners(): void {
  appEventListeners.clear()
}

/** Points `app.getPath("userData")` (and every other path electron-log asks for) at `path`. */
export function setElectronUserDataPath(path: string): void {
  state.userDataPath = path
}

/**
 * Points `app.getPath(name)` (and `app.getAppPath()` for `name: "appRoot"`) at
 * `path`, for names distinct from `userData`. Falls back to `userDataPath`
 * when a name was never set here, so existing tests that only ever called
 * `setElectronUserDataPath` keep seeing one folder for every name.
 */
export function setElectronPath(name: "appData" | "home" | "appRoot", path: string): void {
  namedPaths[name] = path
}

/**
 * Stands in for the `electron` module so a main-process adapter can be imported
 * under plain Node instead of a running Electron process.
 *
 * Importers that reach `electron` here:
 *
 * - `src/ipc/adapters/modScan.ts` imports `app` directly, to find the folder mod
 *   icons are cached under (`app.getPath("userData")`).
 * - `src/utils/logManager.ts` imports `electron-log`, which builds an
 *   `ElectronExternalApi` at its own module load
 *   (`node_modules/electron-log/src/main/ElectronExternalApi.js`) and reads a
 *   handful of `app` members through optional chaining to name the app, find its
 *   log folder and decide whether it is running packaged. Nothing in modScan.ts
 *   calls these, but they still have to exist on the mock or electron-log's own
 *   import-time wiring throws before modScan.ts's `import` line is even reached.
 * - `src/ipc/handlers/*.ts` call `ipcMain.handle` at module load, and some of
 *   them call `dialog`/`shell` methods inside the callback.
 *
 * Every member is read live from `state`/`namedPaths` rather than closed over
 * at factory time, so `setElectronUserDataPath`/`setElectronPath` can move it
 * per test without a second `vi.mock`. `ipcMain.handle` records channel ->
 * callback into ipcHandlerRegistry.ts instead of doing anything with them;
 * `getIpcHandler` (re-exported above) reads a callback back out so a test can
 * invoke it directly with a fake event, the same way a real IPC dispatch
 * would. `dialog`'s methods are plain `vi.fn()`s a test configures with
 * `vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce(...)` after
 * `import { dialog } from "electron"`.
 */
vi.mock("electron", () => {
  const app = {
    getPath: (name: string): string => namedPaths[name] ?? state.userDataPath,
    getAppPath: (): string => namedPaths["appRoot"] ?? state.userDataPath,
    /**
     * electron-log's `isDev()` prefers this flag over inspecting `process.execPath`.
     * False matches how the built main process actually runs, which is the
     * process these adapters are written for.
     */
    isPackaged: false,
    /** electron-log's `getAppName()` falls back to these; only has to be a string. */
    name: "RiftLauncher",
    getName: (): string => "RiftLauncher",
    /** electron-log's `getAppVersion()`; only has to be a string. */
    getVersion: (): string => "0.0.0-test",
    /**
     * electron-log's `onAppReady()`/`onAppEvent()` call these through optional
     * chaining (`this.electron.app?.on`). No-ops are enough: nothing under test
     * waits on an app lifecycle event, so there is nothing to ever invoke the
     * registered handler with. `workerManager.ts` also calls `app.on("before-quit", ...)`
     * at module load, for the same reason.
     */
    isReady: (): boolean => true,
    on: (event: string, listener: (...args: unknown[]) => void): void => {
      const listeners = appEventListeners.get(event) ?? []
      listeners.push(listener)
      appEventListeners.set(event, listeners)
    },
    off: (): void => {},
    once: (): void => {}
  }

  const ipcMain = {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
      registerIpcHandler(channel, listener)
    }
  }

  const dialog = { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }
  const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(), openExternal: vi.fn() }

  return { app, ipcMain, dialog, shell }
})
