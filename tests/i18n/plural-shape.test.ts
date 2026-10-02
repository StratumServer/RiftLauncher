import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { describe, it } from "vitest"

import { collectPluralFamilies, findBarePluralKeys, findDuplicateJsonKeys, flattenTranslationObject, listLocaleFiles, LOCALES_DIR, PLURAL_SUFFIXES, requiredPluralCategories } from "./helpers"

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

  it("writes the forms of every plural family side by side, in the order Hosted Weblate emits them", () => {
    // Hosted Weblate writes a family's forms together, in the order of PLURAL_SUFFIXES, so a file that
    // spells them any other way gets that line moved by the first Weblate commit that touches it. Read off
    // the parsed file, object by object (JSON.parse keeps key order): the flattened map forgets what sat
    // next to what.
    function misordered(value: unknown, prefix = ""): string[] {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return []

      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj)
      const families = new Set<string>()
      for (const key of keys) {
        const suffix = PLURAL_SUFFIXES.find((candidate) => key.endsWith(candidate))
        if (suffix) families.add(key.slice(0, -suffix.length))
      }

      const here = [...families].flatMap((family) => {
        const forms = PLURAL_SUFFIXES.map((suffix) => family + suffix).filter((key) => key in obj)
        const positions = forms.map((key) => keys.indexOf(key))
        const found = keys.slice(Math.min(...positions), Math.max(...positions) + 1)
        if (JSON.stringify(found) === JSON.stringify(forms)) return []

        const spell = (key: string): string => (forms.includes(key) ? key.slice(family.length) : key)
        return [`${prefix ? `${prefix}.` : ""}${family} reads ${found.map(spell).join(", ")} where Hosted Weblate writes ${forms.map(spell).join(", ")}`]
      })

      return [...here, ...Object.entries(obj).flatMap(([key, child]) => misordered(child, prefix ? `${prefix}.${key}` : key))]
    }

    const failures = localeFiles.flatMap((file) => misordered(JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"))).map((failure) => `${file}: ${failure}`))

    assert.deepEqual(failures, [], `plural families Hosted Weblate would reorder on its first save: ${failures.join(" | ")}`)
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
