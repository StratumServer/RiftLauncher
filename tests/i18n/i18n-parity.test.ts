import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { describe, it } from "vitest"

import { collectTranslationCalls, flattenTranslationObject, listLocaleFiles, LOCALES_DIR, RENDERER_SRC_DIR, TranslationCall } from "./helpers"

/**
 * Guards the translation system (part of issue #15).
 *
 * en-US.json is the fallback locale (src/renderer/src/i18n.ts) and the only
 * one every t() call site is checked against: recent slices routinely add
 * keys to en-US first and let other locales catch up later, so lagging
 * behind en-US is expected and NOT a failure here. Only two classes of
 * mistake are hard failures:
 *   1. code that references a t() key which does not exist anywhere, even
 *      in en-US (the "added the code, forgot the key" mistake)
 *   2. a locale file (including en-US.json) that is structurally broken
 * Everything else -- how far behind a locale is, or which keys it has that
 * en-US no longer does -- is reported so humans (and future tooling) can
 * act on it, but it never fails the suite.
 */

function readLocaleJson(file: string): unknown {
  return JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"))
}

describe("t() keys referenced in src/renderer/** exist in en-US.json", () => {
  const calls: TranslationCall[] = collectTranslationCalls(RENDERER_SRC_DIR)
  const enUS = flattenTranslationObject(readLocaleJson("en-US.json"))

  it("collected a plausible number of string-literal t() call sites", () => {
    // A sanity floor: if a refactor changes how t() is called (renamed hook,
    // different call shape) and the regex stops matching, this catches the
    // collector silently going quiet instead of the suite going green for
    // the wrong reason.
    assert.ok(calls.length > 50, `expected more than 50 t() call sites, found ${calls.length}`)
  })

  it("every statically referenced key exists in en-US.json", () => {
    const uniqueKeys = [...new Set(calls.map((call) => call.key))]
    const missing = uniqueKeys.filter((key) => !(key in enUS))

    assert.deepEqual(missing, [], `t() keys referenced in code but missing from en-US.json: ${missing.join(", ")}`)
  })

  it("passes an interpolation object at every call site whose en-US string needs one", () => {
    // Best-effort static guard for the class of bug fixed in PR #22: a string
    // gains a {{placeholder}} but a call site is never updated to pass the
    // matching object. Only string-literal key call sites are checked --
    // t(dynamicKey) sites are already excluded by the collector itself, since
    // their key cannot be resolved statically.
    const offenders = calls.filter((call) => {
      const value = enUS[call.key]
      return typeof value === "string" && /\{\{\s*[\w.]+\s*\}\}/.test(value) && !call.hasInterpolationArg
    })

    assert.deepEqual(offenders, [], `t() calls with no interpolation object for a key whose en-US value needs one: ${offenders.map((o) => `"${o.key}" in ${o.file}`).join(", ")}`)
  })
})

describe("en-US.json integrity", () => {
  const enUS = flattenTranslationObject(readLocaleJson("en-US.json"))

  it("parses as JSON", () => {
    assert.doesNotThrow(() => readLocaleJson("en-US.json"))
  })

  it("has no key with an empty string value", () => {
    const empty = Object.entries(enUS)
      .filter(([, value]) => value === "")
      .map(([key]) => key)

    assert.deepEqual(empty, [], `en-US.json keys with an empty string value: ${empty.join(", ")}`)
  })
})

describe("locale files stay structurally sound", () => {
  const localeFiles = listLocaleFiles()

  it("every locale file under src/renderer/src/locales parses as JSON", () => {
    const failures = localeFiles
      .map((file) => {
        try {
          JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"))
          return null
        } catch (error) {
          return `${file}: ${(error as Error).message}`
        }
      })
      .filter((failure): failure is string => failure !== null)

    assert.deepEqual(failures, [], `locale files that fail to parse: ${failures.join("; ")}`)
  })
})

describe("locale coverage snapshot (report only, does not fail on lag)", () => {
  it("prints missing/orphan key counts for every non-English locale relative to en-US", () => {
    const enUS = flattenTranslationObject(readLocaleJson("en-US.json"))
    const enKeys = new Set(Object.keys(enUS))

    const otherLocales = listLocaleFiles().filter((file) => file !== "en-US.json")

    const rows = otherLocales.map((file) => {
      const locale = basename(file, ".json")

      let localeKeys: Set<string>
      try {
        localeKeys = new Set(Object.keys(flattenTranslationObject(readLocaleJson(file))))
      } catch {
        // A parse failure here is already a hard failure in the test above;
        // this snapshot just skips it rather than double-reporting.
        return { locale, keys: 0, missing: 0, orphans: 0, unparseable: true }
      }

      const missing = [...enKeys].filter((key) => !localeKeys.has(key)).length
      const orphans = [...localeKeys].filter((key) => !enKeys.has(key)).length

      return { locale, keys: localeKeys.size, missing, orphans, unparseable: false }
    })

    const header = `locale  | keys | missing vs en-US (${enKeys.size}) | orphans`
    const lines = rows.map((row) =>
      row.unparseable
        ? `${row.locale.padEnd(7)} | unparseable, see structural integrity test`
        : `${row.locale.padEnd(7)} | ${String(row.keys).padStart(4)} | ${String(row.missing).padStart(23)} | ${String(row.orphans).padStart(7)}`
    )

    console.log(["", "i18n locale coverage snapshot:", header, ...lines].join("\n"))

    // This describe block is a report, not a gate: it only asserts that it
    // ran and produced rows, never on the lag numbers themselves.
    assert.ok(rows.length > 0)
  })
})

describe("Activity Center translation contract", () => {
  const enUS = flattenTranslationObject(readLocaleJson("en-US.json"))
  const activityKeys = Object.keys(enUS).filter((key) => key.startsWith("components.activityCenter."))

  it("keeps the new Activity Center namespace complete and non-empty in every locale", () => {
    const failures = listLocaleFiles()
      .map((file) => {
        const locale = flattenTranslationObject(readLocaleJson(file))
        const missing = activityKeys.filter((key) => !(key in locale))
        const empty = activityKeys.filter((key) => typeof locale[key] !== "string" || locale[key].trim().length === 0)
        return missing.length === 0 && empty.length === 0 ? null : `${file}: missing=${missing.join(",")}; empty=${empty.join(",")}`
      })
      .filter((failure): failure is string => failure !== null)

    assert.deepEqual(failures, [], `incomplete Activity Center translations: ${failures.join(" | ")}`)
  })
})

describe("fr-FR stays in step with en-US", () => {
  // French is kept complete on purpose (issue #411): a slice that adds an
  // en-US key adds its French one in the same PR, so the next feature can't
  // land half-translated. The other locales are not held to this yet -- the
  // coverage snapshot above reports how far behind each of them is.
  const enUS = flattenTranslationObject(readLocaleJson("en-US.json"))
  const frFR = flattenTranslationObject(readLocaleJson("fr-FR.json"))

  /** The {{interpolations}} and <components /> a string carries, sorted so order never matters. */
  function markers(value: unknown): string[] {
    return typeof value === "string" ? (value.match(/\{\{[^}]+\}\}|<\/?[A-Za-z][^>]*>/g) ?? []).sort() : []
  }

  it("has every en-US key with a non-empty string value", () => {
    const missing = Object.keys(enUS).filter((key) => typeof frFR[key] !== "string" || (frFR[key] as string).trim().length === 0)

    assert.deepEqual(missing, [], `en-US keys with no French translation: ${missing.join(", ")}`)
  })

  it("carries the same placeholders and component tags as en-US", () => {
    const mismatched = Object.keys(enUS)
      .filter((key) => key in frFR)
      .filter((key) => markers(enUS[key]).join("|") !== markers(frFR[key]).join("|"))
      .map((key) => `${key} (en-US: ${markers(enUS[key]).join(" ") || "none"}; fr-FR: ${markers(frFR[key]).join(" ") || "none"})`)

    assert.deepEqual(mismatched, [], `fr-FR strings whose placeholders differ from en-US: ${mismatched.join(", ")}`)
  })

  it("has no key en-US does not have", () => {
    const orphans = Object.keys(frFR).filter((key) => !(key in enUS))

    assert.deepEqual(orphans, [], `fr-FR keys en-US no longer has: ${orphans.join(", ")}`)
  })
})

describe("pt-BR worlds namespace", () => {
  const ptBR = flattenTranslationObject(readLocaleJson("pt-BR.json"))

  it("resolves world strings under features.worlds rather than features.backups", () => {
    assert.equal(ptBR["features.worlds.title"], "Mundos")
    assert.equal(ptBR["features.worlds.confirmDelete"], "Digite {{name}} para excluir este mundo permanentemente.")
    assert.equal(ptBR["features.backups.worlds.title"], undefined)
  })
})
