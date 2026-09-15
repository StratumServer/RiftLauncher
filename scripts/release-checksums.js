#!/usr/bin/env node
/**
 * Appends a "Checksums and scans" section to a GitHub release's notes: the
 * SHA-256 of every asset, plus a VirusTotal link for the ones a player can
 * actually run.
 *
 * Why (#494): the Windows installer is not code-signed, so SmartScreen and a
 * few antivirus engines warn on a fresh install and people reasonably refuse
 * to run it. Signing is a money and identity decision for the team; publishing
 * a hash and a public scan alongside every download is not, and it gives a
 * suspicious player something to check. Signing itself is tracked in #351.
 *
 * Run it by hand against any existing release:
 *
 *   GH_TOKEN=... VIRUSTOTAL_API_KEY=... node scripts/release-checksums.js v1.7.0-beta.10
 *
 * VirusTotal is best effort on purpose. No key, quota exhausted, API down, an
 * analysis still queued after the poll budget: the section is still written,
 * with a plain link to the file's page by hash instead of a detection count.
 * A release must never fail because a third party is having a bad day.
 *
 * Assets are looked up by hash first (GET /files/<sha256>). A published build
 * is usually already known to VirusTotal, which turns a 100 MB upload into one
 * cheap request; the upload path only runs for a file nobody has submitted.
 */

const { createHash } = require("node:crypto")
const { createReadStream, openAsBlob, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { spawnSync } = require("node:child_process")

const SECTION_HEADING = "## Checksums and scans"

// VirusTotal takes a direct POST up to 32 MB. Anything larger needs a
// one-shot upload URL first (GET /files/upload_url).
const DIRECT_UPLOAD_LIMIT = 32 * 1024 * 1024

// The free public API allows 4 requests per minute. One request every 15 s
// stays inside it without tracking a window.
const QUOTA_INTERVAL_MS = 15_000

// An analysis of a 100 MB installer takes minutes, not seconds. Give up after
// this and fall back to the file's page.
const ANALYSIS_BUDGET_MS = 10 * 60 * 1000

// Update metadata, not programs. electron-updater reads them, nobody executes
// them, and every engine would report "unsupported file type".
const METADATA_SUFFIXES = [".yml", ".blockmap"]

const NOTE =
  "`latest.yml`, `latest-linux.yml` and the `.blockmap` are update metadata rather than programs, so they are listed by hash only. To check a download yourself: `certutil -hashfile <file> SHA256` on Windows, `sha256sum <file>` on Linux."

/** True when the file has to go through the upload_url dance instead of a direct POST. */
function needsUploadUrl(sizeBytes) {
  return sizeBytes > DIRECT_UPLOAD_LIMIT
}

/** Milliseconds to wait before the next VirusTotal request, given when the last one started. */
function quotaDelayMs(lastRequestAt, now) {
  if (lastRequestAt === undefined) return 0
  return Math.max(0, QUOTA_INTERVAL_MS - (now - lastRequestAt))
}

function isMetadata(name) {
  return METADATA_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * One table row. `scan` is undefined for metadata files, `{}` when VirusTotal
 * could not be reached, and `{ detected, engines }` for a completed analysis.
 */
function formatRow({ name, sha256, scan }) {
  const link = `https://www.virustotal.com/gui/file/${sha256}`
  let cell = "not scanned"
  if (scan !== undefined) cell = scan.engines === undefined ? `[report](${link})` : `[${scan.detected} of ${scan.engines} engines](${link})`
  return `| ${name} | \`${sha256}\` | ${cell} |`
}

function buildSection(rows) {
  return [SECTION_HEADING, "", "| File | SHA-256 | VirusTotal |", "| --- | --- | --- |", ...rows.map(formatRow), "", NOTE].join("\n")
}

/** Replaces an existing section in the notes, or appends one, leaving everything else alone. */
function withSection(body, section) {
  const lines = (body ?? "").split("\n")
  const start = lines.findIndex((line) => line.trim() === SECTION_HEADING)
  if (start === -1) {
    const head = (body ?? "").trimEnd()
    return head === "" ? `${section}\n` : `${head}\n\n${section}\n`
  }

  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].startsWith("## ")) {
      end = index
      break
    }
  }
  const before = lines.slice(0, start).join("\n").trimEnd()
  const after = lines.slice(end).join("\n").trim()
  const head = before === "" ? section : `${before}\n\n${section}`
  return after === "" ? `${head}\n` : `${head}\n\n${after}\n`
}

function warn(message) {
  console.warn(`[release-checksums] ${message}`)
}

function gh(args, { capture = true } = {}) {
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" })
  if (result.status !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed with status ${result.status}`)
  return result.stdout ?? ""
}

function sha256Of(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every VirusTotal call goes through here: one key header, one rate limit, one place to fail. */
async function virusTotal(url, init = {}) {
  await sleep(quotaDelayMs(virusTotal.lastRequestAt, Date.now()))
  virusTotal.lastRequestAt = Date.now()

  const response = await fetch(url, {
    ...init,
    headers: { "x-apikey": process.env.VIRUSTOTAL_API_KEY, ...init.headers },
    signal: AbortSignal.timeout(init.timeoutMs ?? 10 * 60 * 1000)
  })
  // 404 is an answer ("we have never seen this file"), not a failure.
  if (!response.ok && response.status !== 404) throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}`)
  return response
}

function countedEngines(stats) {
  const detected = (stats.malicious ?? 0) + (stats.suspicious ?? 0)
  const engines = detected + (stats.undetected ?? 0) + (stats.harmless ?? 0) + (stats.timeout ?? 0)
  return { detected, engines }
}

async function submit(path, name, sizeBytes) {
  let endpoint = "https://www.virustotal.com/api/v3/files"
  if (needsUploadUrl(sizeBytes)) {
    const urlResponse = await virusTotal("https://www.virustotal.com/api/v3/files/upload_url")
    endpoint = (await urlResponse.json()).data
  }

  const form = new FormData()
  form.append("file", await openAsBlob(path), name)
  const response = await virusTotal(endpoint, { method: "POST", body: form })
  return (await response.json()).data.id
}

async function waitForAnalysis(analysisId) {
  const deadline = Date.now() + ANALYSIS_BUDGET_MS
  while (Date.now() < deadline) {
    const response = await virusTotal(`https://www.virustotal.com/api/v3/analyses/${analysisId}`)
    const attributes = (await response.json()).data.attributes
    if (attributes.status === "completed") return countedEngines(attributes.stats)
  }
  warn("analysis did not complete inside the poll budget, linking the file page instead")
  return {}
}

/** Best effort by design: any problem here downgrades the row to a plain link. */
async function scan(path, name, sha256) {
  if (!process.env.VIRUSTOTAL_API_KEY) return {}

  try {
    const known = await virusTotal(`https://www.virustotal.com/api/v3/files/${sha256}`)
    if (known.ok) {
      const stats = (await known.json()).data.attributes.last_analysis_stats
      console.log(`[release-checksums] ${name}: already known to VirusTotal`)
      return countedEngines(stats)
    }

    const sizeBytes = statSync(path).size
    console.log(`[release-checksums] ${name}: uploading ${(sizeBytes / 1024 / 1024).toFixed(1)} MB to VirusTotal`)
    return await waitForAnalysis(await submit(path, name, sizeBytes))
  } catch (error) {
    // Never interpolate anything that could carry the key; this is our own message.
    warn(`VirusTotal is unavailable for ${name} (${error.message}), linking the file page instead`)
    return {}
  }
}

async function main() {
  const tag = process.argv[2]
  if (!tag) {
    console.error("usage: node scripts/release-checksums.js <tag>")
    process.exit(2)
  }

  const workdir = mkdtempSync(join(tmpdir(), "release-checksums-"))
  try {
    gh(["release", "download", tag, "--dir", workdir, "--clobber"], { capture: false })

    const rows = []
    for (const name of readdirSync(workdir).sort()) {
      const path = join(workdir, name)
      const sha256 = await sha256Of(path)
      rows.push({ name, sha256, scan: isMetadata(name) ? undefined : await scan(path, name, sha256) })
    }

    const body = JSON.parse(gh(["release", "view", tag, "--json", "body"])).body
    const notes = join(workdir, "notes.md")
    writeFileSync(notes, withSection(body, buildSection(rows)))
    gh(["release", "edit", tag, "--notes-file", notes], { capture: false })
    console.log(`[release-checksums] wrote ${rows.length} rows to the notes of ${tag}`)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

module.exports = { SECTION_HEADING, DIRECT_UPLOAD_LIMIT, QUOTA_INTERVAL_MS, needsUploadUrl, quotaDelayMs, isMetadata, formatRow, buildSection, withSection }

if (require.main === module) {
  main().catch((error) => {
    console.error(`[release-checksums] ${error.message}`)
    process.exit(1)
  })
}
