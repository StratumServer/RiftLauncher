import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, it } from "vitest"
import { flattenTranslationObject } from "./i18n/helpers"

/**
 * The 1.7.0-beta.9 pass took the exclamation marks out of every string that reaches a
 * notification. #411 collected the ones it did not cover: task descriptions and page copy, which
 * a player reads in exactly the same places and in the same breath, and this walk went past those
 * to sweep every string value in en-US.json.
 *
 * en-US only: it is the fallback every other locale falls back to, and the rest are handled by the
 * translation pass. Nothing here is allowlisted today. If a string genuinely needs an exclamation
 * mark, add its key below with a comment explaining why, rather than loosening the walk itself.
 */

const EN_US = resolve(__dirname, "..", "src", "renderer", "src", "locales", "en-US.json")

const ALLOWLISTED_EXCLAMATIONS: readonly string[] = []

describe("page copy and task descriptions do not shout (#411)", () => {
  const enUS: unknown = JSON.parse(readFileSync(join(EN_US), "utf8"))
  const strings = flattenTranslationObject(enUS)

  it("found string values to check", () => {
    assert.ok(Object.keys(strings).length > 0, "en-US.json produced no string values, the walk is broken")
  })

  for (const [key, value] of Object.entries(strings)) {
    if (typeof value !== "string" || ALLOWLISTED_EXCLAMATIONS.includes(key)) continue
    it(`${key} does not contain "!"`, () => {
      assert.ok(!value.includes("!"), `${key} still contains an exclamation mark: ${value}`)
    })
  }
})
