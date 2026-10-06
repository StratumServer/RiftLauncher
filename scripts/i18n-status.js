#!/usr/bin/env node
/**
 * Translation status for `src/renderer/src/locales`, as one markdown table.
 *
 * Per locale: how many keys the file carries, how many en-US keys it is still
 * missing, how many keys it has that en-US no longer does (stale), and a link to
 * the strings Hosted Weblate marks "Needs editing" for that language. What
 * still wants a native review lives there rather than in this repository: the
 * machine drafts a seeding pass wrote before Weblate carry that state, Weblate
 * sets it again on a string whose English changed, and a translator clears it
 * by correcting or confirming the string.
 *
 * A value that is exactly "" is missing, not carried (#680): Hosted Weblate
 * writes a plural form it has not had translated yet that way, and the launcher
 * shows the English sentence for it (returnEmptyString is false in
 * src/renderer/src/i18n.ts).
 *
 * This is a report, not a gate: lag is expected (see the coverage snapshot in
 * tests/i18n/i18n-parity.test.ts) and no number here fails anything. Two things
 * still throw. A locale file that does not parse is a real breakage the parity
 * suite fails on too. A locale file with no entry in WEBLATE_CODES would get a
 * dead link, so a new language cannot be added without one.
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
const START = "<!-- i18n-status:start -->"
const END = "<!-- i18n-status:end -->"

// Hosted Weblate's language code for each locale file. It cannot be derived from the file name
// (pt-BR is pt_BR there, zh-CN is zh_Hans), so a new locale file has to be added here by hand.
const WEBLATE_CODES = {
  "be-BY": "be",
  "de-DE": "de",
  "es-ES": "es",
  "fr-FR": "fr",
  "hu-HU": "hu",
  "it-IT": "it",
  "nl-NL": "nl",
  "pl-PL": "pl",
  "pt-BR": "pt_BR",
  "pt-PT": "pt_PT",
  "ru-RU": "ru",
  "uk-UA": "uk",
  "zh-CN": "zh_Hans"
}
const WEBLATE_COMPONENT = "https://hosted.weblate.org/translate/riftlauncher/launcher"

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

// i18next v4 cardinal plural suffixes (issue #496: no bare key keeps one of these as a sibling).
const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"]

// Whole numbers wide enough to hit every cardinal category a language distinguishes for an
// integer (same probe as tests/i18n/helpers.ts's requiredPluralCategories, duplicated here so
// this script stays dependency-free and importable from a bare checkout).
const INTEGER_PLURAL_PROBES = [0, 1, 2, 3, 5, 11, 21, 22, 25, 100, 101, 1_000_000]

/** The cardinal plural categories `locale` selects between for a whole number. */
function requiredPluralCategories(locale) {
  const rules = new Intl.PluralRules(locale)
  return new Set(INTEGER_PLURAL_PROBES.map((count) => rules.select(count)))
}

/** The bare family name of every plural key in `keys`, e.g. "features.mods.modsCount". */
function pluralFamiliesOf(keys) {
  const families = new Set()
  for (const key of keys) {
    const suffix = PLURAL_SUFFIXES.find((candidate) => key.endsWith(candidate))
    if (suffix) families.add(key.slice(0, -suffix.length))
  }
  return families
}

/** The markdown link to `locale`'s strings Weblate marks "Needs editing". Throws for a locale with no Weblate code. */
function reviewLink(locale) {
  if (!Object.hasOwn(WEBLATE_CODES, locale)) throw new Error(`No Weblate language code for ${locale}.json: add it to WEBLATE_CODES in scripts/i18n-status.js`)

  return `[Needs editing](${WEBLATE_COMPONENT}/${WEBLATE_CODES[locale]}/?q=state:needs-editing)`
}

/** One row per locale file in `dir`, en-US excluded (it is the source). */
function localeRows(dir) {
  const enKeys = [...Object.keys(flattenLocale(readJson(join(dir, SOURCE))))]
  const nonPluralEnKeys = enKeys.filter((key) => !PLURAL_SUFFIXES.some((suffix) => key.endsWith(suffix)))
  const pluralFamilies = [...pluralFamiliesOf(enKeys)]

  const rows = readdirSync(dir)
    .filter((file) => file.endsWith(".json") && file !== SOURCE)
    .sort()
    .map((file) => {
      const locale = basename(file, ".json")
      // Only what has a value to show: an exact "" is missing, as the header says.
      const keys = new Set(
        Object.entries(flattenLocale(readJson(join(dir, file))))
          .filter(([, value]) => value !== "")
          .map(([key]) => key)
      )

      // en-US's key set, expanded to the plural categories this locale's own
      // grammar selects (Intl.PluralRules), instead of en-US's one/other: a
      // Slavic locale's _few/_many are real forms it needs, not stale ones,
      // and Chinese's single _other is all it is missing, not en-US's _one too.
      const categories = requiredPluralCategories(locale)
      const expected = new Set(nonPluralEnKeys)
      for (const family of pluralFamilies) for (const category of categories) expected.add(`${family}_${category}`)

      return {
        locale,
        keys: keys.size,
        missing: [...expected].filter((key) => !keys.has(key)).length,
        stale: [...keys].filter((key) => !expected.has(key)).length,
        review: reviewLink(locale)
      }
    })

  return { sourceKeys: enKeys.length, rows }
}

/** Markdown table, padded the way Prettier formats one so `format:check` stays green. */
function renderTable(rows) {
  const header = ["Locale", "Keys", "Missing", "Stale", "To review on Weblate"]
  const body = rows.map((row) => [row.locale, String(row.keys), String(row.missing), String(row.stale), row.review])
  const widths = header.map((title, column) => Math.max(title.length, ...body.map((cells) => cells[column].length)))
  // The name and link columns are left-aligned, the counts right-aligned.
  const leftAligned = (column) => column === 0 || column === header.length - 1
  const pad = (value, column) => (leftAligned(column) ? value.padEnd(widths[column]) : value.padStart(widths[column]))
  const line = (cells) => `| ${cells.map(pad).join(" | ")} |`
  const rule = `| ${widths.map((width, column) => (leftAligned(column) ? "-".repeat(width) : `${"-".repeat(width - 1)}:`)).join(" | ")} |`

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
