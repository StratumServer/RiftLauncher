// Spawned by tests/utils/autoUpdaterModuleShape.test.ts under node's own ESM/CJS interop rather
// than vitest's. Vitest's CJS interop enumerates electron-updater's `autoUpdater` getter and
// hands it back as a named binding, which is exactly why an unmocked `await import("electron-updater")`
// inside a vitest test cannot reproduce the bug this file exists to catch: node's real interop
// runs cjs-module-lexer's static analysis over electron-updater's source, that analysis does not
// recognise `Object.defineProperty(exports, "autoUpdater", { get: ... })` as a named export, and
// so the named binding never appears here the way it does under vitest.
//
// Reading electron-updater's `autoUpdater` getter (through either path) constructs a real,
// platform-specific updater, which needs `electron.app` to exist before the module can finish
// loading. There is no Electron process in this child, so `electron` is stubbed in the CJS
// require cache before the import runs, the same shape tests/ipc/appUpdaterHandlers.test.ts and
// tests/main/autoUpdaterEvents.test.ts already stub for `vi.mock("electron", ...)`.
import { createRequire, Module } from "node:module"

const req = createRequire(import.meta.url)
const electronPath = req.resolve("electron")
// A real Module instance rather than a plain object cast into shape, so the stub satisfies
// node's own NodeModule type (id, children, paths, require, ...) without a hand-typed lie.
const electronStub = new Module(electronPath)
electronStub.filename = electronPath
electronStub.loaded = true
electronStub.exports = {
  app: {
    getPath: (): string => "/tmp/rift-launcher-module-shape-test",
    getAppPath: (): string => "/tmp/rift-launcher-module-shape-test",
    isPackaged: false,
    name: "RiftLauncher",
    getName: (): string => "RiftLauncher",
    getVersion: (): string => "1.7.0-beta.6",
    isReady: (): boolean => true,
    on: (): void => {},
    off: (): void => {},
    once: (): void => {},
    whenReady: (): Promise<void> => Promise.resolve()
  }
}
req.cache[electronPath] = electronStub

/** Whether every method loadAutoUpdater's callers actually rely on is present and callable. */
function methodSurface(candidate: unknown): Record<string, boolean> {
  const target = candidate as Record<string, unknown> | null | undefined
  return {
    checkForUpdates: typeof target?.checkForUpdates === "function",
    downloadUpdate: typeof target?.downloadUpdate === "function",
    quitAndInstall: typeof target?.quitAndInstall === "function",
    on: typeof target?.on === "function"
  }
}

// This deliberately runs electron-updater's real dynamic import rather than the shipped
// src/utils/autoUpdaterLoader.ts: that file also imports through this repo's `@src/*` alias,
// which plain node cannot resolve without a loader, and the one loader already a dependency
// here (tsx, see tests/ipc/atomicJsonFile.test.ts) turned out to reintroduce the exact problem
// this file exists to catch. Tried directly: running this same probe under
// `node --import tsx` reports `hasOwnNamedAutoUpdater: true`, the wrong answer, because tsx's
// own CJS/ESM interop enumerates electron-updater's getter the same way vitest's does. So this
// stays a plain, loader-free node process, and it proves the fact the fix depends on
// (`mod.autoUpdater` is absent, `mod.default.autoUpdater` is not) directly rather than by
// re-running code that cannot be run this way without hiding the bug again.
async function main(): Promise<void> {
  const namespace = (await import("electron-updater")) as Record<string, unknown> & { default?: Record<string, unknown> }

  const hasOwnNamedAutoUpdater = Object.prototype.hasOwnProperty.call(namespace, "autoUpdater")
  const defaultExports = namespace.default
  const defaultAutoUpdaterDescriptor = defaultExports ? Object.getOwnPropertyDescriptor(defaultExports, "autoUpdater") : undefined

  // The exact expression src/utils/autoUpdaterLoader.ts resolves through, reproduced here so the
  // parent test can assert on its outcome without being able to import that file directly.
  const namedAutoUpdater = namespace.autoUpdater
  const defaultAutoUpdater = defaultExports?.autoUpdater
  const resolvedAutoUpdater = namedAutoUpdater ?? defaultAutoUpdater
  const resolvedFrom = namedAutoUpdater ? "named" : defaultAutoUpdater ? "default" : "neither"

  console.log(
    JSON.stringify({
      hasOwnNamedAutoUpdater,
      hasDefaultAutoUpdaterDescriptor: Boolean(defaultAutoUpdaterDescriptor),
      resolvedFrom,
      resolvedMethods: methodSurface(resolvedAutoUpdater)
    })
  )
}

void main()
