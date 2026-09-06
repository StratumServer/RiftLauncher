#!/usr/bin/env node
/**
 * `npm ci` on this project leaves one native-tooling gap that has nothing to do
 * with the code being worked on. It is dev/test-only: packaged builds are
 * unaffected because electron-builder and electron-vite handle it on their own.
 *
 * As of Electron 42, the `electron` package shipped its own `postinstall`
 * (`node install.js`) that downloaded the platform binary; that hook was
 * removed from its package.json, so a plain `npm ci` no longer fetches
 * node_modules/electron/dist at all. `npm run dev` and anything that spawns
 * Electron then fails until install.js is run by hand. Cheap to close here
 * since this script already runs on install.
 *
 * The fix is idempotent and safe to run on every `npm install`.
 *
 * Set ELECTRON_SKIP_BINARY_DOWNLOAD to opt out. A job that only runs tsc or
 * eslint never launches Electron, so a hiccup on the download mirror should
 * not be able to fail it. The check lives here rather than downstream:
 * electron 44's install.js does not read that variable, and neither does
 * @electron/get 5, so nothing below this script would honour it.
 */

const { existsSync } = require("node:fs")
const { join } = require("node:path")
const { spawnSync } = require("node:child_process")

function ensureElectronBinaryIsDownloaded() {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.log("[fix-native-deps] ELECTRON_SKIP_BINARY_DOWNLOAD is set, skipping the electron binary download")
    return
  }

  const electronDir = join(__dirname, "..", "node_modules", "electron")
  const installScript = join(electronDir, "install.js")

  // electron is not installed (e.g. a production-only install); nothing to do.
  if (!existsSync(installScript)) return

  const distMarker = join(electronDir, "path.txt")
  if (existsSync(distMarker)) return // install.js already ran; let it fast-exit on its own if unsure.

  console.log("[fix-native-deps] electron binary missing, running node_modules/electron/install.js")
  const result = spawnSync(process.execPath, [installScript], { cwd: electronDir, stdio: "inherit" })

  if (result.status !== 0) {
    console.error("[fix-native-deps] failed to download the electron binary")
    process.exitCode = result.status ?? 1
  }
}

ensureElectronBinaryIsDownloaded()
