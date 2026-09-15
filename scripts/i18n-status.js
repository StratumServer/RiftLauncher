#!/usr/bin/env node
/**
 * Translation status for `src/renderer/src/locales`, as one markdown table.
 *
 * Per locale: how many keys the file carries, how many en-US keys it is still
 * missing, how many keys it has that en-US no longer does (stale), and how many
 * of its values are machine drafts nobody has reviewed yet. The drafted counts
 * come from `drafted.json` in the same folder (locale -> the keys that pass
 * wrote), maintained by whoever seeds a locale; a locale absent from it counts
 * as fully human-written.
 *
 * This is a report, not a gate: lag is expected (see the coverage snapshot in
 * tests/i18n/i18n-parity.test.ts) and no number here fails anything. A locale
 * file that does not parse still throws, since that is a real breakage the
 * parity suite fails on too.
 *
 * No dependency on purpose: the workflow runs it straight from a checkout,
 * with no `npm ci` in front of it.
 *
 *   node scripts/i18n-status.js                    print the table
 *   node scripts/i18n-status.js --dir <folder>     read another locales folder
 *   node scripts/i18n-status.js --write <page.md>  splice the table into a page,
 *                                                  between the marker comments
 */

const { readFileSync, readdirSync, writeFileSync } = require("node:fs")
const { basename, join } = require("node:path")

const DEFAULT_DIR = join(__dirname, "..", "src", "renderer", "src", "locales")
const SOURCE = "en-US.json"
const DRAFTED = "drafted.json"
const START = "<!-- i18n-status:start -->"
const END = "<!-- i18n-status:end -->"

/**
 * Flattens a nested translation object into dot-path keys, e.g.
 * `{ generic: { email: "Email" } }` becomes `{ "generic.email": "Email" }`.
 * Anything that is not a plain object (string, number, array, null) is a leaf.
 */
function flattenLocale(value, prefix = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return prefix ? { [prefix]: value } : {}

  const out = {}
  for (const [key, child] of Object.entries(value)) Object.assign(out, flattenLocale(child, prefix ? `${prefix}.${key}` : key))
  return out
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

/** One row per locale file in `dir`, en-US excluded (it is the source). */
function localeRows(dir) {
  const enKeys = new Set(Object.keys(flattenLocale(readJson(join(dir, SOURCE)))))

  let drafted = {}
  try {
    drafted = readJson(join(dir, DRAFTED))
  } catch {
    // No drafted list in this folder: nothing is flagged for review.
  }

  const rows = readdirSync(dir)
    .filter((file) => file.endsWith(".json") && file !== SOURCE && file !== DRAFTED)
    .sort()
    .map((file) => {
      const locale = basename(file, ".json")
      const keys = new Set(Object.keys(flattenLocale(readJson(join(dir, file)))))
      const draftedKeys = Array.isArray(drafted[locale]) ? drafted[locale] : []

      return {
        locale,
        keys: keys.size,
        missing: [...enKeys].filter((key) => !keys.has(key)).length,
        stale: [...keys].filter((key) => !enKeys.has(key)).length,
        // A drafted key en-US has since dropped is counted as stale, not as
        // review work, so it is not counted twice.
        drafted: draftedKeys.filter((key) => enKeys.has(key)).length
      }
    })

  return { sourceKeys: enKeys.size, rows }
}

/** Markdown table, padded the way Prettier formats one so `format:check` stays green. */
function renderTable(rows) {
  const header = ["Locale", "Keys", "Missing", "Stale", "Drafted to review"]
  const body = rows.map((row) => [row.locale, String(row.keys), String(row.missing), String(row.stale), String(row.drafted)])
  const widths = header.map((title, column) => Math.max(title.length, ...body.map((cells) => cells[column].length)))
  // First column left-aligned (names), the counts right-aligned.
  const pad = (value, column) => (column === 0 ? value.padEnd(widths[column]) : value.padStart(widths[column]))
  const line = (cells) => `| ${cells.map(pad).join(" | ")} |`
  const rule = `| ${widths.map((width, column) => (column === 0 ? "-".repeat(width) : `${"-".repeat(width - 1)}:`)).join(" | ")} |`

  return [line(header), rule, ...body.map(line)].join("\n")
}

function renderReport(dir) {
  const { sourceKeys, rows } = localeRows(dir)

  return `en-US is the source and carries ${sourceKeys} keys.\n\n${renderTable(rows)}\n`
}

/** Replaces whatever sits between the markers in `file`. Returns true if the page changed. */
function writePage(file, report) {
  const page = readFileSync(file, "utf8")
  const start = page.indexOf(START)
  const end = page.indexOf(END)
  if (start === -1 || end === -1 || end < start) throw new Error(`${file} is missing the ${START} / ${END} markers`)

  const updated = `${page.slice(0, start + START.length)}\n\n${report}\n${page.slice(end)}`
  if (updated === page) return false

  writeFileSync(file, updated)
  return true
}

function main(argv) {
  const dirFlag = argv.indexOf("--dir")
  const writeFlag = argv.indexOf("--write")
  const dir = dirFlag === -1 ? DEFAULT_DIR : argv[dirFlag + 1]
  const report = renderReport(dir)

  if (writeFlag === -1) {
    process.stdout.write(report)
    return
  }

  const page = argv[writeFlag + 1]
  console.log(writePage(page, report) ? `${page} updated` : `${page} already up to date`)
}

main(process.argv.slice(2))
