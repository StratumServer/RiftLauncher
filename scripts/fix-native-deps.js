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
 */

const { existsSync } = require("node:fs")
const { join } = require("node:path")
const { spawnSync } = require("node:child_process")

function ensureElectronBinaryIsDownloaded() {
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
