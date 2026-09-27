import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { describe, it } from "vitest"

import { collectPluralFamilies, findBarePluralKeys, findDuplicateJsonKeys, flattenTranslationObject, listLocaleFiles, LOCALES_DIR, requiredPluralCategories } from "./helpers"

/**
 * The plural shape Hosted Weblate enforces on save (issue #506's follow-up):
 * translate-toolkit's I18NextV4File (component format i18nextv4) keeps only
 * the integer CLDR categories Intl.PluralRules gives a language and drops
 * everything else, including every _zero (i18next honours it for a literal
 * count of 0 ahead of the language's own plural rule, but no language shipped
 * here has a real CLDR zero category, so Weblate never keeps it).
 *
 * i18n-parity.test.ts already asserts the other half of this: a family a
 * locale has started translating is never missing a category its language
 * needs. This file asserts a locale never carries one it does NOT need
 * either -- the form Weblate would silently delete on its first commit -- so
 * a locale that round-trips clean today cannot quietly grow one back.
 */
describe("every locale carries exactly its language's integer plural categories", () => {
  const localeFiles = listLocaleFiles()

  it("has no plural form beyond what Intl.PluralRules selects for that locale, in any locale file", () => {
    const failures = localeFiles.flatMap((file) => {
      const locale = basename(file, ".json")
      const required = new Set(requiredPluralCategories(locale))
      const present = collectPluralFamilies(flattenTranslationObject(JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"))))

      return [...present.entries()].flatMap(([family, categories]) => {
        const extra = [...categories].filter((category) => !required.has(category))
        return extra.length === 0 ? [] : [`${file}: ${family} carries _${extra.join(", _")}, which ${locale} never selects`]
      })
    })

    assert.deepEqual(failures, [], `plural forms Hosted Weblate would drop on its first save: ${failures.join(" | ")}`)
  })

  it("has no _zero form anywhere, since no language shipped here has a CLDR zero category", () => {
    const failures = localeFiles.flatMap((file) => {
      const flat = flattenTranslationObject(JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8")))
      return Object.keys(flat)
        .filter((key) => key.endsWith("_zero"))
        .map((key) => `${file}: ${key}`)
    })

    assert.deepEqual(failures, [], `_zero forms found: ${failures.join(", ")}`)
  })

  it("has no bare key sitting beside its own plural suffixes (subsumes the old no-bare-plural-keys check)", () => {
    const offenses = localeFiles.flatMap((file) => {
      const data: unknown = JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"))
      return findBarePluralKeys(data).map((key) => `"${key}" in ${file}`)
    })

    assert.deepEqual(offenses, [], `bare plural keys found (key exists alongside a _one/_two/_few/_many/_other sibling): ${offenses.join(", ")}`)
  })

  it("has no duplicate key in any locale file", () => {
    const failures = localeFiles.flatMap((file) => {
      const text = readFileSync(join(LOCALES_DIR, file), "utf8")
      return findDuplicateJsonKeys(text).map((key) => `${file}: ${key}`)
    })

    assert.deepEqual(failures, [], `duplicate JSON keys found (JSON.parse silently keeps only the last value): ${failures.join(", ")}`)
  })
})

describe("findDuplicateJsonKeys", () => {
  it("reports a key repeated inside the same object, by its dotted path, and nothing when there is no repeat", () => {
    const withDuplicate = '{"a": {"b": 1, "c": 2, "b": 3}}'
    assert.deepEqual(findDuplicateJsonKeys(withDuplicate), ["a.b"])

    const withoutDuplicate = '{"a": {"b": 1, "c": [1, 2, {"b": 4}]}, "d": "b"}'
    assert.deepEqual(findDuplicateJsonKeys(withoutDuplicate), [])
  })
})
