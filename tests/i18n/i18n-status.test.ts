import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * Covers `npm run i18n:status`, the report the pull request workflow comments and
 * the docs status page carries (issue #496).
 *
 * The script is exercised through its command line rather than imported: it is
 * plain dependency-free Node so the workflow can run it from a bare checkout,
 * and importing an untyped .js file would mean turning allowJs on for the whole
 * tests project. `--dir` points it at a fixture folder, so the numbers asserted
 * here stay fixed while the real locales move.
 */

const SCRIPT = resolve(__dirname, "..", "..", "scripts", "i18n-status.js")

function fixture(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "i18n-status-"))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content, null, 2))
  return dir
}

function run(...args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" })
}

const SOURCE = { generic: { email: "Email", name: "Name" }, features: { config: { title: "Config" } } }

describe("i18n status report", () => {
  it("counts nested keys by their dot path, on both sides", () => {
    const dir = fixture({
      "en-US.json": SOURCE,
      // Missing generic.name and features.config.title, and carries one key en-US dropped.
      "es-ES.json": { generic: { email: "Correo" }, legacy: { gone: "Se fue" } }
    })

    assert.match(run("--dir", dir), /^\| es-ES\s+\|\s+2 \|\s+2 \|\s+1 \|\s+0 \|$/m)
  })

  it("renders the table Prettier's way, with drafted counts from drafted.json", () => {
    const dir = fixture({
      "en-US.json": SOURCE,
      "es-ES.json": { generic: { email: "Correo" }, legacy: { gone: "Se fue" } },
      "fr-FR.json": { generic: { email: "Courriel", name: "Nom" }, features: { config: { title: "Configuration" } } },
      // "features.gone" is no longer an en-US key: it is stale, not review work.
      "drafted.json": { "es-ES": ["generic.email", "features.gone"] }
    })

    assert.equal(
      run("--dir", dir),
      [
        "en-US is the source and carries 3 keys.",
        "",
        "| Locale | Keys | Missing | Stale | Drafted to review |",
        "| ------ | ---: | ------: | ----: | ----------------: |",
        "| es-ES  |    2 |       2 |     1 |                 1 |",
        "| fr-FR  |    3 |       0 |     0 |                 0 |",
        ""
      ].join("\n")
    )
  })

  it("splices the report between the markers of the status page", () => {
    const dir = fixture({ "en-US.json": SOURCE, "fr-FR.json": SOURCE })
    const page = join(dir, "page.md")
    writeFileSync(page, "# Status\n\nIntro.\n\n<!-- i18n-status:start -->\n\nstale table\n\n<!-- i18n-status:end -->\n\nFooter.\n")

    run("--dir", dir, "--write", page)
    const written = readFileSync(page, "utf8")

    assert.match(written, /# Status\n\nIntro\./)
    assert.match(written, /\| fr-FR\s+\|\s+3 \|\s+0 \|\s+0 \|\s+0 \|/)
    assert.ok(!written.includes("stale table"), "the previous table should be replaced")
    assert.match(written, /<!-- i18n-status:end -->\n\nFooter\.\n$/)
    assert.match(run("--dir", dir, "--write", page), /already up to date/)
  })
})
