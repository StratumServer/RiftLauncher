import { readdirSync, readFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Repo root, resolved from this file's own location so it works regardless of the process cwd. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const RENDERER_SRC_DIR = join(REPO_ROOT, "src", "renderer", "src")
export const LOCALES_DIR = join(RENDERER_SRC_DIR, "locales")

const SOURCE_EXTENSIONS = [".ts", ".tsx"]

/**
 * JSON files under LOCALES_DIR that are not locales. drafted.json maps a locale
 * to the keys a seeding pass machine-drafted (issue #496), read by
 * scripts/i18n-status.js; holding it to a locale's contract would be nonsense.
 */
const NON_LOCALE_FILES = ["drafted.json"]

/** The locale files the launcher ships, sorted, e.g. ["be-BY.json", "de-DE.json", ...]. */
export function listLocaleFiles(): string[] {
  return readdirSync(LOCALES_DIR)
    .filter((file) => file.endsWith(".json") && !NON_LOCALE_FILES.includes(file))
    .sort()
}

/**
 * Recursively lists every file under `dir` whose extension is in `extensions`.
 */
export function listSourceFiles(dir: string, extensions: string[] = SOURCE_EXTENSIONS): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => extensions.includes(extname(entry)))
    .map((entry) => join(dir, entry))
}

/**
 * Flattens a nested translation object into dot-path keys, e.g.
 * `{ generic: { email: "Email" } }` becomes `{ "generic.email": "Email" }`.
 * Non plain-object leaves (strings, numbers, arrays, null) stop the recursion
 * as-is, so a structurally odd locale file still flattens instead of throwing.
 */
export function flattenTranslationObject(value: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) out[prefix] = value
    return out
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    Object.assign(out, flattenTranslationObject(child, path))
  }

  return out
}

/** i18next v4 cardinal plural suffixes (issue #496: no bare key keeps one of these as a sibling). */
export const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"]

/**
 * Resolves a t() key against a flattened translation object the way i18next
 * resolves it at runtime: if `key` itself is not a property, but at least one
 * of its cardinal-suffixed siblings (key_one, key_other, ...) is, that
 * sibling's value stands in for it. A plural family never keeps both a bare
 * and a suffixed key (see no-bare-plural-keys.test.ts), so any one present
 * suffix is representative enough for the parity checks that call this.
 * Returns undefined only when neither the bare key nor any suffix exists.
 */
export function resolveTranslationValue(flattened: Record<string, unknown>, key: string): unknown {
  if (key in flattened) return flattened[key]
  const suffix = PLURAL_SUFFIXES.find((candidate) => `${key}${candidate}` in flattened)
  return suffix ? flattened[`${key}${suffix}`] : undefined
}

export type TranslationCall = {
  /** Absolute path to the source file the call was found in. */
  file: string
  /** The literal key passed to t(), e.g. "features.backups.backupWhilePlaying". */
  key: string
  /** Whether the call passed a second argument, e.g. t("key", { count }). */
  hasInterpolationArg: boolean
}

// Matches t("some.key" possibly followed by more arguments. Only string-literal
// keys are matched on purpose: t(someVariable) call sites use a dynamic key that
// cannot be resolved by static analysis, so they are simply invisible to this
// regex and are skipped rather than mis-collected.
const T_CALL_RE = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g

/**
 * Scans every .ts/.tsx file under `dir` for string-literal t("...") call sites.
 * Dynamic-key calls like t(messageKey) are not matched and are silently skipped,
 * as documented on the goal this test suite serves (issue #15).
 */
export function collectTranslationCalls(dir: string): TranslationCall[] {
  const calls: TranslationCall[] = []

  for (const file of listSourceFiles(dir)) {
    const content = readFileSync(file, "utf8")
    let match: RegExpExecArray | null

    T_CALL_RE.lastIndex = 0
    while ((match = T_CALL_RE.exec(content))) {
      // Group 1 is a mandatory capturing group in T_CALL_RE (not `(...)?`), so it
      // is always defined whenever the overall match succeeds.
      const key = match[1]!
      let cursor = T_CALL_RE.lastIndex
      // `cursor < content.length` guards the indexed access from being out of bounds.
      while (cursor < content.length && /\s/.test(content[cursor]!)) cursor++
      calls.push({ file, key, hasInterpolationArg: content[cursor] === "," })
    }
  }

  return calls
}
