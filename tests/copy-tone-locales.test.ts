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

/**
 * The follow-up swept the rest of en-US.json: every string value in the file, not just the keys
 * #411 named. Nothing here is allowlisted today. If a string genuinely needs an exclamation mark,
 * add its key below with a comment explaining why, rather than loosening the walk itself.
 */

const ALLOWLISTED_EXCLAMATIONS: readonly string[] = []

function collectStringPaths(node: unknown, path: string, out: Map<string, string>): void {
  if (typeof node === "string") {
    out.set(path, node)
    return
  }
  if (typeof node === "object" && node !== null) {
    for (const [childKey, childValue] of Object.entries(node)) {
      collectStringPaths(childValue, path ? `${path}.${childKey}` : childKey, out)
    }
  }
}

describe("no en-US string shouts (#411 follow-up)", () => {
  const enUS: unknown = JSON.parse(readFileSync(join(EN_US), "utf8"))
  const strings = new Map<string, string>()
  collectStringPaths(enUS, "", strings)

  it("found string values to check", () => {
    assert.ok(strings.size > 0, "en-US.json produced no string values, the walk is broken")
  })

  for (const [key, value] of strings) {
    if (ALLOWLISTED_EXCLAMATIONS.includes(key)) continue
    it(`${key} does not contain "!"`, () => {
      assert.ok(!value.includes("!"), `${key} still contains an exclamation mark: ${value}`)
    })
  }
})
