#!/usr/bin/env node
/**
 * `npm ci` on this project leaves two native-tooling gaps that have nothing
 * to do with the code being worked on. Both are dev/test-only: packaged
 * builds are unaffected because electron-builder and electron-vite handle
 * them on their own.
 *
 * 1. node_modules/7zip-bin/<platform>/<arch>/7za(.exe) sometimes loses its
 *    executable bit in transit (registries and some npm/tar combinations do
 *    not reliably preserve unix permissions while packing/unpacking). Any
 *    code path that spawns it then fails with `EACCES`. See #30.
 *
 * 2. As of Electron 42, the `electron` package shipped its own
 *    `postinstall` (`node install.js`) that downloaded the platform binary;
 *    that hook was removed from its package.json, so a plain `npm ci` no
 *    longer fetches node_modules/electron/dist at all. `npm run dev` and
 *    anything that spawns Electron then fails until install.js is run by
 *    hand. Cheap to close here since this script already runs on install.
 *
 * Both fixes are idempotent and safe to run on every `npm install`.
 */

const { chmodSync, existsSync, statSync } = require("node:fs")
const { join } = require("node:path")
const { spawnSync } = require("node:child_process")

function restoreSevenZipExecutableBit() {
  // .exe needs no unix executable bit, and Windows has no such concept.
  if (process.platform === "win32") return

  let path7za
  try {
    ;({ path7za } = require("7zip-bin"))
  } catch {
    return // 7zip-bin is not installed; nothing to fix.
  }

  if (!path7za || !existsSync(path7za)) return

  const isExecutable = (statSync(path7za).mode & 0o111) !== 0
  if (isExecutable) return

  chmodSync(path7za, 0o755)
  console.log(`[fix-native-deps] restored executable bit on ${path7za}`)
}

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

restoreSevenZipExecutableBit()
ensureElectronBinaryIsDownloaded()
