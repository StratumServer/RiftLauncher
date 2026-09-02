import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * Guards the `afterPack` hook that removes the Windows-only WebGPU
 * shader-compiler DLLs from a packaged build.
 *
 * Electron 28+ ships dxcompiler.dll (25.6 MB) and dxil.dll (1.5 MB) on
 * Windows solely for Chromium's experimental WebGPU DirectX shader compiler.
 * Electron itself dropped both from its own Windows release zips for the
 * same reason (https://github.com/electron/electron/pull/41120), and this
 * renderer has no WebGPU surface. There is no `files`-style way to exclude
 * Electron's own runtime binaries (only the app payload), so
 * scripts/afterPack.js deletes them from the already-copied `appOutDir`
 * instead. A later edit that removes the yml key, or breaks the win32 guard
 * or the file list in the script, would only surface in a full Windows NSIS
 * build otherwise, so both halves are pinned here.
 *
 * electron-builder.yml is read as text for the same reason
 * tests/config/electron-builder-locales.test.ts does: js-yaml is only a
 * transitive dependency of electron-updater, and importing it here would be
 * an undeclared dependency.
 */
describe("electron-builder afterPack hook", () => {
  const yml = readFileSync(resolve(__dirname, "../../electron-builder.yml"), "utf8")

  it("wires scripts/afterPack.js as the afterPack hook", () => {
    assert.match(yml, /^afterPack: scripts\/afterPack\.js$/m)
  })
})

describe("afterPack.js", () => {
  const source = readFileSync(resolve(__dirname, "../../scripts/afterPack.js"), "utf8")

  it("only acts on win32 packages", () => {
    assert.match(source, /electronPlatformName !== "win32"/)
  })

  it("removes both WebGPU shader-compiler DLLs", () => {
    assert.match(source, /"dxcompiler\.dll"/)
    assert.match(source, /"dxil\.dll"/)
  })

  it("removes the files from appOutDir, not the whole platform tree", () => {
    assert.match(source, /join\(context\.appOutDir, file\)/)
  })
})
