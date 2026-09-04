import type { AppUpdater } from "electron-updater"

import { createUpdaterLogger } from "@src/utils/updaterLogger"

/**
 * The shape a dynamic `import("electron-updater")` actually resolves to under node's ESM
 * interop, as opposed to the shape electron-updater's own .d.ts promises.
 *
 * electron-updater defines its `autoUpdater` export with
 * `Object.defineProperty(exports, "autoUpdater", { get: () => ... })`, a late getter rather
 * than a plain `exports.autoUpdater = ...` assignment. Node's ESM interop finds a CommonJS
 * module's named exports by running cjs-module-lexer's static analysis over the source, and
 * that analysis does not recognise the getter form, so `autoUpdater` never becomes a named
 * binding on the namespace object node hands back. What node's interop always provides,
 * getter or not, is `default`: the module's whole CommonJS `exports` object, unpicked apart.
 * `default.autoUpdater` reaches the same getter through that object instead of through a named
 * binding that was never created. Confirmed directly: an unmocked import in this repo's own
 * Electron process has `hasOwnProperty(mod, "autoUpdater") === false` and
 * `hasOwnProperty(mod, "default") === true`.
 */
interface ElectronUpdaterNamespace {
  /** Only present if a future electron-updater release exports the name in a form the lexer can see. */
  autoUpdater?: AppUpdater
  default: { autoUpdater: AppUpdater }
}

/**
 * The one load of electron-updater this launch has asked for, or nothing when
 * it has not asked yet.
 *
 * The promise is what is remembered, not the module it resolves to, so two
 * callers racing the first load share one import. electron-updater's export is
 * a singleton whose listeners and `autoDownload` flag are configured exactly
 * once (registerAutoUpdaterEvents), and a second import resolving separately
 * would mean a second set of both.
 *
 * A rejected load is remembered too, for the rest of the process's life: nothing here retries
 * or clears `loading` after a failure, so the promise a caller gets back on launch is the same
 * rejected promise every later caller gets, however long the launch runs. A transient failure
 * (the load throwing because, say, a bundler or an antivirus quarantine briefly locked the
 * file) therefore disables updates for the whole session rather than for one attempt.
 */
let loading: Promise<AppUpdater> | undefined

/**
 * Loads electron-updater, on the launches that turn out to need it.
 *
 * It used to be a top-level import in main/index.ts. Measured in the packaged
 * app by timing each top-level require, that import alone cost 88.9 ms of the
 * main module's 163.8 ms inside the asar (reading out of the packaged archive),
 * more than every other dependency put together, and it pulls 159 modules of
 * its own. Against an unpacked build on a faster host the same import is
 * 24.9 ms, within the noise of the other dependencies. Every launch paid it,
 * including the ones that go on to log "Auto-update disabled" and never use
 * the module: a run started with `UPDATE=false`, a Linux run with no
 * `APPIMAGE` set and no deb, rpm or pacman marker next to the packaged app
 * (a Flatpak install, or a dev run), and macOS, which has no published build
 * to update to. It also cost every launch where the updater does arm and the
 * player never accepts an update.
 *
 * The logger is attached here rather than left to the caller so the redaction
 * cannot be missed. electron-updater logs feed URLs and cache paths, and
 * createUpdaterLogger is what routes those through logMessage's redaction
 * before they reach disk; binding it to the load itself leaves no window in
 * which the module exists carrying its own default logger. The ordering that
 * mattered when this lived in main/index.ts still holds for free: every caller
 * reaches this well after `Logger.transports.file.resolvePathFn` is in place,
 * so nothing is written before the app's Logs directory is decided.
 */
export function loadAutoUpdater(): Promise<AppUpdater> {
  loading ??= import("electron-updater").then((mod) => {
    const namespace = mod as unknown as ElectronUpdaterNamespace
    // `mod.autoUpdater` first, so a future electron-updater release whose exports the lexer can
    // see keeps resolving through the named binding it will then actually have; `default.autoUpdater`
    // only stands in for the getter node's interop cannot name today.
    const autoUpdater = namespace.autoUpdater ?? namespace.default.autoUpdater
    autoUpdater.logger = createUpdaterLogger()
    return autoUpdater
  })

  return loading
}
