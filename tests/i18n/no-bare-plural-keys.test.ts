import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "vitest"

import { listLocaleFiles, LOCALES_DIR, PLURAL_SUFFIXES } from "./helpers"

/**
 * Guards against issue #496: a plural family (i18next v4, cardinal suffixes
 * _zero/_one/_two/_few/_many/_other) must not also carry a bare, unsuffixed
 * key. i18next never reads that bare key once any suffixed form exists -- it
 * picks a suffix by the CLDR plural rule for the active count -- so the bare
 * key is dead weight that Weblate reads as a duplicate string carrying the
 * same text as one of the variants.
 */

type BareKeyOffense = { file: string; key: string }

/**
 * Recursively walks a parsed locale object and reports every bare key that
 * sits next to at least one of its own suffixed siblings, as dotted paths
 * relative to `prefix`.
 */
function findBarePluralKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return []

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  const offenses: string[] = []

  for (const key of keys) {
    if (typeof obj[key] === "string" && PLURAL_SUFFIXES.some((suffix) => keys.includes(key + suffix))) {
      offenses.push(prefix ? `${prefix}.${key}` : key)
    }
  }

  for (const key of keys) {
    offenses.push(...findBarePluralKeys(obj[key], prefix ? `${prefix}.${key}` : key))
  }

  return offenses
}

describe("no bare key sits beside its own plural suffixes", () => {
  const localeFiles = listLocaleFiles()

  it("found more than one locale file to check", () => {
    // Sanity floor, same idea as the t() call-site count in i18n-parity.test.ts:
    // if listLocaleFiles() ever goes quiet, this test should not go green for
    // the wrong reason.
    assert.ok(localeFiles.length > 1, `expected more than one locale file, found ${localeFiles.length}`)
  })

  it("has no bare plural key in any locale file", () => {
    const offenses: BareKeyOffense[] = localeFiles.flatMap((file) => {
      const data: unknown = JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"))
      return findBarePluralKeys(data).map((key) => ({ file, key }))
    })

    assert.deepEqual(offenses, [], `bare plural keys found (key exists alongside a _zero/_one/_two/_few/_many/_other sibling): ${offenses.map((o) => `"${o.key}" in ${o.file}`).join(", ")}`)
  })
})
