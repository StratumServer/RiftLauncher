import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"
import { listUnder } from "./ymlBlock"

/**
 * Guards the `electronLanguages` pin in electron-builder.yml.
 *
 * app-builder-lib prunes `locales/*.pak` by matching each shipped pak against
 * the wanted tags with `wanted === lang || wanted.startsWith(lang + "-")`. The
 * wanted tag is the prefix side, so "en" does NOT match "en-US" and would
 * delete every pak, leaving Chromium with no locale data. It does this without
 * logging, because the "no locales found" warning only fires when nothing was
 * deleted. So the value has to be the exact tag "en-US", and a later edit that
 * "simplifies" it to "en", adds an unintended locale, or drops the rationale
 * has to fail here rather than in a packaged build nobody re-checks.
 */
describe("electron-builder locale pruning", () => {
  const yml = readFileSync(resolve(__dirname, "../../electron-builder.yml"), "utf8")

  it("declares an electronLanguages key", () => {
    assert.match(yml, /^electronLanguages:$/m)
  })

  it("keeps exactly the en-US Chromium locale", () => {
    assert.deepEqual(listUnder(yml, "", "electronLanguages"), ["en-US"])
  })

  it("keeps the rationale comment that explains the exact-tag requirement", () => {
    assert.match(yml, /Chromium ships 55 locale \.pak files/)
    assert.match(yml, /The value must be the exact tag "en-US"/)
  })
})
