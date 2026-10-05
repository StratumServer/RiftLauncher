import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { createInstance } from "i18next"
import { describe, it } from "vitest"

import { collectPluralFamilies, flattenTranslationObject, INTEGER_PLURAL_PROBES, listLocaleFiles, LOCALES_DIR, requiredPluralCategories } from "./helpers"

/**
 * The runtime half of the plural contract (issue #496).
 *
 * i18n-parity.test.ts reads the locale files and asserts every family covers
 * the categories its language selects between. This one proves the same thing
 * through i18next itself, because the failure being guarded against is one the
 * file contents alone never showed: before this, ru-RU defined errorCount_one
 * and errorCount_other and looked complete, while i18next selected _few for a
 * count of 2, found nothing, and rendered the English sentence.
 *
 * Every instance here is built with no fallbackLng on purpose. Under the real
 * fallback chain a missing form quietly becomes English, which is the bug; with
 * the chain removed the same miss returns the literal key, which an assertion
 * can see.
 */

function readLocaleJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"))
}

/** An i18next holding one locale and nothing to fall back on. */
function instanceFor(locale: string): ReturnType<typeof createInstance> {
  const i18n = createInstance()
  void i18n.init({ lng: locale, fallbackLng: false, resources: { [locale]: { translation: readLocaleJson(`${locale}.json`) } } })
  return i18n
}

// The same whole numbers requiredPluralCategories probes with, reused here so
// the two cannot drift apart: every count is deliberately an integer, because
// every t() call site that passes `count` passes an array .length or another
// integer counter (grep across src/renderer confirms it). A fractional count
// such as 1.5 -- the only thing that used to select `other` in Russian,
// Ukrainian, Belarusian and Polish -- never reaches i18next here, and Hosted
// Weblate's writer agrees: it keeps only the integer CLDR categories a
// language selects between, `other` not among them for those four (issue
// #506's follow-up).
const PROBE_COUNTS = INTEGER_PLURAL_PROBES

/** One count per category the locale selects, e.g. ru-RU -> { one: 1, few: 2, many: 5, other: 0 }. */
function countPerCategory(locale: string): Map<string, number> {
  const rules = new Intl.PluralRules(locale)
  const samples = new Map<string, number>()

  for (const count of PROBE_COUNTS) {
    const category = rules.select(count)
    if (!samples.has(category)) samples.set(category, count)
  }

  return samples
}

describe("i18next resolves every plural form inside the locale itself", () => {
  const localeFiles = listLocaleFiles()

  it("probes a count for every category each shipped locale selects", () => {
    // If PROBE_COUNTS ever stops covering a category, the loops below would
    // skip it silently and pass for the wrong reason.
    const uncovered = localeFiles.flatMap((file) => {
      const locale = basename(file, ".json")
      const samples = countPerCategory(locale)
      return requiredPluralCategories(locale)
        .filter((category) => !samples.has(category))
        .map((category) => `${locale}: no probe count selects ${category}`)
    })

    assert.deepEqual(uncovered, [], `plural categories no probe count reaches: ${uncovered.join(", ")}`)
  })

  it("never falls through to the key for a count the language treats separately", () => {
    const failures = localeFiles.flatMap((file) => {
      const locale = basename(file, ".json")
      const i18n = instanceFor(locale)
      const samples = countPerCategory(locale)

      return [...collectPluralFamilies(flattenTranslationObject(readLocaleJson(file))).keys()].flatMap((family) =>
        requiredPluralCategories(locale)
          .flatMap((category) => {
            const count = samples.get(category)
            // Unreachable while the probe test above passes, which is the test
            // that owns this gap; skipping keeps this sweep from reporting a
            // missing probe as a missing translation.
            return count === undefined ? [] : [{ category, count }]
          })
          .filter(({ count }) => i18n.t(family, { count }) === family)
          .map(({ category, count }) => `${locale}: ${family} has no ${category} form, count ${count} renders the key`)
      )
    })

    assert.deepEqual(failures, [], `plural forms i18next selects but the locale does not carry: ${failures.join(" | ")}`)
  })

  it("keeps a family a locale still holds as one bare sentence on screen in that language, for every count", () => {
    // Plural forms reach a language through Weblate one language at a time, so a family en-US has already
    // split can sit in another locale as the single sentence it always had. i18next looks for the suffixed
    // form first and then for the bare key inside the same language, which is what stops that sentence from
    // falling through to English (or to the key) for a count the locale has no form for.
    const families = [...collectPluralFamilies(flattenTranslationObject(readLocaleJson("en-US.json"))).keys()]

    const failures = localeFiles.flatMap((file) => {
      const locale = basename(file, ".json")
      const flattened = flattenTranslationObject(readLocaleJson(file))
      const i18n = instanceFor(locale)

      return families
        .filter((family) => typeof flattened[family] === "string")
        .flatMap((family) => PROBE_COUNTS.filter((count) => i18n.t(family, { count }) === family).map((count) => `${locale}: ${family}, count ${count} renders the key`))
    })

    assert.deepEqual(failures, [], `bare sentences i18next does not reach: ${failures.join(" | ")}`)
  })

  it("renders Russian error and warning counts in Russian, not English (the count of 2 Zaldaryon reproduced)", () => {
    // The named case from the review on PR #506, pinned on its own so the
    // regression stays readable next to the sweep above.
    const ruRU = instanceFor("ru-RU")
    const enUS = instanceFor("en-US")

    for (const count of [2, 5]) {
      for (const key of ["features.sessionReport.errorCount", "features.sessionReport.warningCount", "components.activityCenter.activeTasks", "components.activityCenter.newNotifications"]) {
        const russian = ruRU.t(key, { count })
        assert.notEqual(russian, key, `${key} with count ${count} renders the literal key in ru-RU`)
        assert.notEqual(russian, enUS.t(key, { count }), `${key} with count ${count} renders the English string in ru-RU`)
      }
    }
  })
})
