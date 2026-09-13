import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * The 1.7.0-beta.9 pass took the exclamation marks out of every string that reaches a
 * notification. #411 collected the ones it did not cover: task descriptions and page copy, which
 * a player reads in exactly the same places and in the same breath.
 *
 * Only the keys that pass named are held. This is not a rule about the whole locale file: there
 * is plenty of older copy still shouting, and rewriting all of it is a translation job across
 * fourteen locales, not a sweep item. en-US only, for the same reason: it is the fallback every
 * other locale falls back to, and the rest are handled by the translation pass.
 */

const EN_US = resolve(__dirname, "..", "src", "renderer", "src", "locales", "en-US.json")

const KEYS = [
  "features.versions.gameVersionDownloadDesc",
  "features.versions.gameVersionExtractDesc",
  "features.versions.noVersionsFound",
  "features.versions.noVersionsFoundDesc",
  "features.installations.noInstallationsFound",
  "features.infoAndHelp.debugInfoDesc",
  "components.loader.title"
] as const

function lookup(locale: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined), locale)
}

describe("page copy and task descriptions do not shout (#411)", () => {
  const enUS: unknown = JSON.parse(readFileSync(join(EN_US), "utf8"))

  for (const key of KEYS) {
    it(`${key} reads as a plain sentence`, () => {
      const value = lookup(enUS, key)
      assert.equal(typeof value, "string", `${key} is missing from en-US.json`)
      assert.ok(!(value as string).includes("!"), `${key} still ends on an exclamation mark: ${String(value)}`)
    })
  }
})
