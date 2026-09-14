import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * Pins #419 at the source: a log line must never carry a player's paths, Mod names, or
 * labels, only fixed text plus fixed tokens (reason enums, counts, ids, versions).
 * `redactSensitiveText` (src/utils/logManager.ts) catches absolute paths centrally, but it
 * cannot know that a bare file name or a Mod name is sensitive, so the call sites themselves
 * have to stay clean. This walks every .ts/.tsx under src, finds every `logMessage(`,
 * `logMods(`, or `window.api.utils.logMessage(` call, and fails if the interpolated message
 * text carries an identifier that looks like a path, a folder, a file, or a name.
 *
 * What it allows, and why:
 * - `${err}`, `${error}`, `getErrorMessage(...)`: the concrete cause goes to error level so a
 *   reader knows which failure it was (#337), and `redactSensitiveText` already strips any
 *   absolute path out of that text centrally.
 * - reasons, counts, ids, versions (`${result.reason}`, `${scan.mods.length}`, `${modid}`,
 *   `${version.version}`): none of these name a player's files.
 *
 * What it checks per interpolation `${expr}`: every identifier inside `expr` is split on
 * camelCase boundaries, and only the *last* word of each identifier is compared against the
 * risky list. Comparing the whole identifier as a substring would flag plenty of code that
 * has nothing to do with a leak: `rename.reason`, `profiles.length`, `filesWritten`, and
 * `nameTaken` (a rename-conflict counter) all happen to contain "name" or "file" somewhere,
 * but none of them read out a path or a name, they are reasons and counts. What the real
 * leaks in this codebase have in common is that the risky word is the *last* part of the
 * identifier: `configPath`, `modsPath`, `result.filePath`, `folderName`, `archive.zipname`,
 * `safeManifest.name`. Checking only the trailing word catches exactly that shape.
 */

const SRC = resolve(__dirname, "..", "src")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : []
  })
}

// Tolerates one level of nested `{...}` inside a `${...}` expression, which is what the few
// ternaries-with-a-nested-template in this codebase need (e.g. `${x ? `y ${z}` : ""}`).
const BRACE_GROUP = "(?:[^{}]|\\{[^{}]*\\})*"

// The `\$\{...\}` alternative has to come before the generic "any character" one: both can
// match a bare "$" or "{", and if the generic alternative goes first it eats them one
// character at a time, so the engine never tries the brace-aware alternative at all and the
// scan stops at the first backtick it meets, even one that belongs to a nested template.
const LOG_CALL = new RegExp(String.raw`\b(?:logMessage|logMods|window\.api\.utils\.logMessage)\(\s*["'][a-zA-Z]+["']\s*,\s*\x60((?:\$\{${BRACE_GROUP}\}|[^\x60\\]|\\.)*)\x60`, "g")
const EXPRESSION = new RegExp(String.raw`\$\{(${BRACE_GROUP})\}`, "g")
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g
// host/address/url/server joined the list with #460: a server address is somebody's machine, often
// somebody's home, and redactSensitiveText strips absolute paths rather than host names, so there
// is nothing downstream to catch one. The plural `servers` is deliberately NOT here: a count of
// them (`${servers.length}`) names nobody, and the match below is on the whole trailing word.
const RISKY_WORDS = new Set([
  "path",
  "Path",
  "name",
  "Name",
  "folder",
  "Folder",
  "file",
  "File",
  "entry",
  "dir",
  "Dir",
  "zipname",
  "host",
  "Host",
  "address",
  "Address",
  "url",
  "Url",
  "URL",
  "server",
  "Server"
])

function lastCamelWord(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s$]+/)
    .filter(Boolean)
  return words[words.length - 1] ?? identifier
}

function exposesProvenance(expression: string): boolean {
  const identifiers = expression.match(IDENTIFIER) ?? []
  return identifiers.some((identifier) => RISKY_WORDS.has(lastCamelWord(identifier)))
}

interface Violation {
  file: string
  message: string
  expression: string
}

function findViolations(): Violation[] {
  const violations: Violation[] = []

  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8")
    LOG_CALL.lastIndex = 0
    let call: RegExpExecArray | null
    while ((call = LOG_CALL.exec(source))) {
      const message = call[1] ?? ""
      EXPRESSION.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = EXPRESSION.exec(message))) {
        const expression = match[1] ?? ""
        if (exposesProvenance(expression)) violations.push({ file, message, expression })
      }
    }
  }

  return violations
}

describe("log line provenance (#419)", () => {
  it("never interpolates a path, a folder, a file name, a Mod/label name, or a server address into a log line", () => {
    const violations = findViolations()
    const report = violations.map((v) => `${v.file}: \${${v.expression}} in "${v.message}"`).join("\n")
    assert.equal(violations.length, 0, `Found log lines that interpolate a risky identifier:\n${report}`)
  })
})
