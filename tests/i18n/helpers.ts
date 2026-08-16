import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Repo root, resolved from this file's own location so it works regardless of the process cwd. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const RENDERER_SRC_DIR = join(REPO_ROOT, "src", "renderer", "src")
export const LOCALES_DIR = join(RENDERER_SRC_DIR, "locales")

const SOURCE_EXTENSIONS = [".ts", ".tsx"]

/**
 * Recursively lists every file under `dir` whose extension is in `extensions`.
 */
export function listSourceFiles(dir: string, extensions: string[] = SOURCE_EXTENSIONS): string[] {
  const files: string[] = []

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)

    if (stats.isDirectory()) files.push(...listSourceFiles(fullPath, extensions))
    else if (extensions.includes(extname(fullPath))) files.push(fullPath)
  }

  return files
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

export type TranslationCall = {
  /** Absolute path to the source file the call was found in. */
  file: string
  /** The literal key passed to t(), e.g. "features.backups.errorMakingBackup". */
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
