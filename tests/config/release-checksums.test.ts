import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * Guards the pure parts of scripts/release-checksums.js, the script that
 * appends hashes and VirusTotal links to a release's notes (#494).
 *
 * The network half is not tested here: it is best effort by design and every
 * failure path there collapses into the same "link the file page" row, which
 * is one of the cases below. What has to stay correct is the part that edits
 * somebody's published release notes.
 */
const require_ = createRequire(__filename)
const repoRoot = resolve(__dirname, "../..")
const script = require_(resolve(repoRoot, "scripts/release-checksums.js"))

const sha = "a".repeat(64)

describe("release checksum rows", () => {
  it("links a detection count when the analysis completed", () => {
    assert.equal(
      script.formatRow({ name: "riftlauncher-1.0.0-setup.exe", sha256: sha, scan: { detected: 2, engines: 72 } }),
      `| riftlauncher-1.0.0-setup.exe | \`${sha}\` | [2 of 72 engines](https://www.virustotal.com/gui/file/${sha}) |`
    )
  })

  it("falls back to the file page when VirusTotal gave nothing back", () => {
    assert.match(script.formatRow({ name: "a.AppImage", sha256: sha, scan: {} }), new RegExp(`\\[report\\]\\(https://www\\.virustotal\\.com/gui/file/${sha}\\) \\|$`))
  })

  it("marks metadata files as not scanned", () => {
    assert.equal(script.formatRow({ name: "latest.yml", sha256: sha }), `| latest.yml | \`${sha}\` | not scanned |`)
  })

  it("scans installers and skips update metadata", () => {
    assert.deepEqual(
      ["riftlauncher-1.0.0-setup.exe", "riftlauncher-1.0.0-setup.exe.blockmap", "riftlauncher-1.0.0.AppImage", "latest.yml", "latest-linux.yml"].filter((name) => !script.isMetadata(name)),
      ["riftlauncher-1.0.0-setup.exe", "riftlauncher-1.0.0.AppImage"]
    )
  })
})

describe("release tag validation", () => {
  it("accepts a real release tag", () => {
    assert.equal(script.validateTag("v1.7.0-beta.10"), "v1.7.0-beta.10")
  })

  it("refuses a tag carrying shell metacharacters instead of passing it through", () => {
    assert.throws(() => script.validateTag("v1.0.0$(touch pwned)"), /refusing tag/)
    assert.throws(() => script.validateTag("v1.0.0`touch pwned`"), /refusing tag/)
    assert.throws(() => script.validateTag("v1.0.0; rm -rf /"), /refusing tag/)
  })
})

describe("release notes section", () => {
  const section = script.buildSection([{ name: "latest.yml", sha256: sha }])

  it("appends the section without touching what is above it", () => {
    const body = "## What's new\n\nThings.\n"
    const updated = script.withSection(body, section)
    assert.ok(updated.startsWith("## What's new\n\nThings."))
    assert.ok(updated.includes(script.SECTION_HEADING))
  })

  it("replaces the section instead of stacking a second one", () => {
    const once = script.withSection("## What's new\n\nThings.\n", section)
    const twice = script.withSection(once, script.buildSection([{ name: "latest.yml", sha256: "b".repeat(64) }]))

    assert.equal(twice.split(script.SECTION_HEADING).length - 1, 1)
    assert.ok(twice.includes("b".repeat(64)))
    assert.ok(!twice.includes(sha))
    assert.ok(twice.startsWith("## What's new\n\nThings."))
  })

  it("keeps the sections that follow it", () => {
    const body = `## What's new\n\nThings.\n\n${section}\n\n## Known issues\n\nNo macOS build.\n`
    const updated = script.withSection(body, script.buildSection([{ name: "latest.yml", sha256: "c".repeat(64) }]))

    assert.ok(updated.startsWith("## What's new\n\nThings."))
    assert.ok(updated.trimEnd().endsWith("## Known issues\n\nNo macOS build."))
    assert.ok(updated.indexOf(script.SECTION_HEADING) < updated.indexOf("## Known issues"))
  })

  it("handles an empty body", () => {
    assert.ok(script.withSection("", section).startsWith(script.SECTION_HEADING))
  })
})

describe("VirusTotal limits", () => {
  it("takes the upload_url path only past the 32 MB direct POST limit", () => {
    assert.equal(script.needsUploadUrl(31 * 1024 * 1024), false)
    assert.equal(script.needsUploadUrl(script.DIRECT_UPLOAD_LIMIT), false)
    assert.equal(script.needsUploadUrl(script.DIRECT_UPLOAD_LIMIT + 1), true)
    // Every binary asset of a real release is over it.
    assert.equal(script.needsUploadUrl(105_712_215), true)
  })

  it("paces requests at four per minute", () => {
    assert.equal(script.QUOTA_INTERVAL_MS, 15_000)
    assert.equal(script.quotaDelayMs(undefined, 1_000), 0)
    assert.equal(script.quotaDelayMs(1_000, 1_000), 15_000)
    assert.equal(script.quotaDelayMs(1_000, 6_000), 10_000)
    // A slow upload already spent the window; the next call goes out at once.
    assert.equal(script.quotaDelayMs(1_000, 90_000), 0)
  })

  it("schedules five sequential requests a minute apart", () => {
    let now = 0
    let lastRequestAt: number | undefined
    const starts: number[] = []
    for (let index = 0; index < 5; index++) {
      now += script.quotaDelayMs(lastRequestAt, now)
      lastRequestAt = now
      starts.push(now)
    }
    assert.deepEqual(starts, [0, 15_000, 30_000, 45_000, 60_000])
  })
})

describe("release workflow", () => {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8")

  it("can be dispatched against an existing tag", () => {
    assert.match(workflow, /^ {2}workflow_dispatch:$/m)
    assert.match(workflow, /^ {6}tag:$/m)
  })

  it("builds on a tag push only and always runs the scan job", () => {
    assert.match(workflow, /^ {2}build-and-draft:\n {4}if: github\.event_name == 'push'$/m)
    assert.match(workflow, /^ {2}checksums-and-scans:$/m)
    assert.match(workflow, /needs: build-and-draft/)
    assert.match(workflow, /always\(\) && \(github\.event_name == 'workflow_dispatch' \|\| needs\.build-and-draft\.result == 'success'\)/)
  })

  it("calls the script with the dispatched tag or the pushed one", () => {
    assert.match(workflow, /VIRUSTOTAL_API_KEY: \$\{\{ secrets\.VIRUSTOTAL_API_KEY \}\}/)
  })

  it("passes the tag through the step environment instead of interpolating it into the shell", () => {
    // A `${{ }}` expression is substituted into the run script's text before
    // bash parses it, so it must never sit inside the run: line itself; it
    // has to arrive as an already-set environment variable that the shell
    // only expands, never re-parses.
    assert.match(workflow, /RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/)
    assert.match(workflow, /run: node scripts\/release-checksums\.js "\$RELEASE_TAG"/)
    assert.doesNotMatch(workflow, /run:.*\$\{\{.*\}\}/)
  })

  // The regexes above pin the lines that matter but would happily pass on a
  // file GitHub refuses to parse. js-yaml is only a transitive dependency of
  // electron-updater here (see electron-builder-icon-files.test.ts), so the
  // actual parse borrows PyYAML when the machine has it and is skipped when
  // it does not; CI runners do.
  const hasPyYaml = spawnSync("python3", ["-c", "import yaml"]).status === 0

  it.skipIf(!hasPyYaml)("parses as YAML with both jobs", () => {
    const parsed = spawnSync("python3", ["-c", "import sys,yaml;print(sorted(yaml.safe_load(open(sys.argv[1]))['jobs']))", resolve(repoRoot, ".github/workflows/release.yml")], { encoding: "utf8" })

    assert.equal(parsed.status, 0, parsed.stderr)
    assert.equal(parsed.stdout.trim(), "['build-and-draft', 'checksums-and-scans']")
  })
})
