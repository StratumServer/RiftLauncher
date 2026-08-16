import { vi } from "vitest"

/**
 * Mutable per-test state the mock reads from at call time. Tests set the
 * userData path in `beforeEach`, once they have made a fresh temp directory, so
 * `app.getPath("userData")` always points somewhere private to the running test
 * rather than to a value baked in when the mock factory ran.
 */
const state = { userDataPath: "" }

/** Points `app.getPath("userData")` (and every other path electron-log asks for) at `path`. */
export function setElectronUserDataPath(path: string): void {
  state.userDataPath = path
}

/**
 * Stands in for the `electron` module so a main-process adapter can be imported
 * under plain Node instead of a running Electron process.
 *
 * Two importers reach `electron` here, not one:
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
 *
 * Every member is read live from `state` rather than closed over at factory time,
 * so `setElectronUserDataPath` can move it per test without a second `vi.mock`.
 */
vi.mock("electron", () => {
  const app = {
    /**
     * modScan.ts's `modImagesFolder()` joins this with `Cache/Images/Mods`.
     * electron-log's `getAppUserDataPath()` and `getElectronLogPath()` call the
     * same function (with `"userData"` and `"logs"` respectively); returning the
     * same temp path for every name is fine here since nothing asserts on where
     * electron-log itself writes.
     */
    getPath: (): string => state.userDataPath,
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
     * registered handler with.
     */
    isReady: (): boolean => true,
    on: (): void => {},
    off: (): void => {},
    once: (): void => {}
  }

  return { app }
})
