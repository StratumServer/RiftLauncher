#!/usr/bin/env node
/**
 * electron-builder `afterPack` hook: drops `dxcompiler.dll` and `dxil.dll`
 * from a packaged Windows build.
 *
 * Electron 28+ ships both files solely for Chromium's experimental WebGPU
 * DirectX shader compiler. Electron itself stopped shipping them in its own
 * Windows release zips for the same reason
 * (https://github.com/electron/electron/pull/41120); this renderer has no
 * WebGPU surface (no `navigator.gpu` use anywhere in src/renderer), so the
 * packaged app never asks for them. Together they are 27,126,144 bytes
 * installed and 6,918,045 bytes of the compressed NSIS `setup.exe`. The
 * packaged `RiftLauncher.exe` was launched from `win-unpacked` after removal
 * and stayed running.
 *
 * `electron-builder.yml`'s `win`/`mac`/`linux` blocks only choose what goes
 * *into* the package; there is no `files`-style exclusion for the Electron
 * runtime binaries themselves; deleting the two DLLs from the already-copied
 * `appOutDir` after packing is the supported way to drop them.
 */

const { rm } = require("node:fs/promises")
const { join } = require("node:path")

const REMOVED_FILES = ["dxcompiler.dll", "dxil.dll"]

/** @param {import("electron-builder").AfterPackContext} context */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return

  await Promise.all(REMOVED_FILES.map((file) => rm(join(context.appOutDir, file), { force: true })))
}
