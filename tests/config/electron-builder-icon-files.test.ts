import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * Guards the `files` exclusions for `resources/icon.icns`,
 * `resources/icon.ico`, and the scripts/ directory in electron-builder.yml.
 *
 * `asarUnpack: resources/**` ships every file under resources/ unpacked on
 * every platform, but only resources/icon.png is read at runtime
 * (src/main/index.ts, `?asset`). icon.ico is still used by electron-builder
 * itself at build time (win.icon, nsis.installerIcon), which resolves that
 * path from the project directory before this files list is even consulted,
 * so excluding it here only drops the copy that would otherwise sit unused in
 * the installed app; icon.icns is not referenced anywhere in this config at
 * all.
 *
 * scripts/ holds dev and test helpers (fix-native-deps.js,
 * measure-windows-runtime.ps1) that nothing under out/ imports.
 * fix-native-deps.js runs from the postinstall script in the project
 * directory, which a packaged app never executes, so dropping that exclusion
 * fails no build and no other test: the two files simply reappear inside the
 * asar.
 *
 * An edit that drops any of the three lines puts the icons (1,031,735 bytes,
 * unpacked beside the asar) or the scripts (7,470 bytes of asar) back into
 * every packaged build without failing a platform build, which is why these
 * are text pins rather than left to be caught by eye.
 *
 * The file is read as text for the same reason
 * tests/config/electron-builder-locales.test.ts does: js-yaml is only a
 * transitive dependency of electron-updater, and importing it here would be
 * an undeclared dependency.
 */
describe("electron-builder packaged file exclusions", () => {
  const yml = readFileSync(resolve(__dirname, "../../electron-builder.yml"), "utf8")

  it("excludes resources/icon.icns from the packaged app", () => {
    assert.match(yml, /^\s*- "!resources\/icon\.icns"\s*$/m)
  })

  it("excludes resources/icon.ico from the packaged app", () => {
    assert.match(yml, /^\s*- "!resources\/icon\.ico"\s*$/m)
  })

  it("excludes the scripts directory from the packaged app", () => {
    assert.match(yml, /^\s*- "!scripts\{,\/\*\*\/\*\}"\s*$/m)
  })
})
