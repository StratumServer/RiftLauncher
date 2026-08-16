/**
 * Windows install conformance check, run by hand from the
 * windows-conformance workflow. Not a vitest suite: this is the same shape as
 * the RIFT_E2E_ARCHIVE run in tests/ipc/extraction.test.ts, a real end to end
 * pass against the live catalog and a real disposable machine, driven with
 * `tsx` instead of the test runner.
 *
 * Two scenarios:
 *
 * 1. Clean install. Download the real Windows installer the catalog
 *    publishes, run it silently with the exact flags RUN_INSTALLER uses
 *    (src/ipc/handlers/pathsHandlers.ts), and assert Vintagestory.exe lands in
 *    the requested folder. Failing this fails the job.
 *
 * 2. Seeded uninstall key. Pre-seed the HKCU uninstall registry key that
 *    arms Inno Setup's "old version detected" MsgBox (issue #8), then run the
 *    same installer silently again and record what happens: exit code,
 *    whether the run timed out waiting on a dialog nothing answers, and
 *    where the game actually landed. This scenario never fails the job on
 *    its own: an unresolved dialog or a redirected install is the documented,
 *    expected-bad outcome it exists to put on the record, not a bug in this
 *    script.
 *
 * Registry writes only ever happen under CI, guarded below, so nobody points
 * this at a real machine and seeds their actual uninstall key by accident.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs"
import { request as httpsRequest } from "node:https"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { assertAllowedApiUrl, assertAllowedDownloadUrl, assertSafeFileName, isRecord, MAX_RESPONSE_BYTES } from "../../src/ipc/validation"

if (!process.env.CI) {
  console.error("Refusing to run outside CI: this script writes to HKCU\\...\\Uninstall to reproduce issue #8. Run it only through the windows-conformance workflow.")
  process.exit(1)
}

if (process.platform !== "win32") {
  console.error("This script only makes sense on Windows: it exercises RUN_INSTALLER's Inno Setup flags and the HKCU uninstall key InitializeSetup checks.")
  process.exit(1)
}

const CATALOG_URL = "https://api.vintagestory.at/stable.json"
// Smallest stable Windows installer that still uses the current
// vs_install_win-x64_<v>.exe naming (424.9 MB, versus 570.4 MB for the
// current latest, 1.22.6): see the PR body for the full size survey. Older
// versions are smaller still but predate that naming scheme and were not
// checked against today's extraction assumptions.
const DEFAULT_VERSION = "1.18.15"
// The AppId Inno Setup writes to the uninstall registry on every run, and the
// key issue #8's InitializeSetup check looks for.
const UNINSTALL_KEY_GUID = "{70364653-036D-49B3-8B80-AF39665F29C1}_is1"
const UNINSTALL_KEY_PATH = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_KEY_GUID}`
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000
const SCENARIO_2_TIMEOUT_MS = 3 * 60 * 1000

type CatalogPlatformEntry = {
  filename: string
  filesize: string
  md5: string
  cdnUrl: string
}

type InstallerRunResult = {
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

function asCatalogPlatformEntry(value: unknown): CatalogPlatformEntry | undefined {
  if (!isRecord(value)) return undefined
  const urls = value.urls
  if (typeof value.filename !== "string" || typeof value.filesize !== "string" || typeof value.md5 !== "string" || !isRecord(urls) || typeof urls.cdn !== "string") return undefined
  return { filename: value.filename, filesize: value.filesize, md5: value.md5, cdnUrl: urls.cdn }
}

function fetchCatalog(): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = assertAllowedApiUrl(CATALOG_URL)
    const request = httpsRequest(url, { method: "GET" }, (response) => {
      const statusCode = response.statusCode ?? 0
      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        rejectPromise(new Error(`Catalog request failed with status ${statusCode}`))
        return
      }

      let body = ""
      let bytes = 0
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy()
          rejectPromise(new Error("Catalog response is too large"))
          return
        }
        body += chunk.toString("utf8")
      })
      response.on("error", (error) => rejectPromise(error))
      response.on("end", () => {
        try {
          resolvePromise(JSON.parse(body))
        } catch {
          rejectPromise(new Error("Catalog response was not valid JSON"))
        }
      })
    })

    request.on("error", (error) => rejectPromise(error))
    request.end()
  })
}

function downloadFile(url: URL, destinationPath: string, expectedMd5: string): Promise<{ bytes: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const digest = createHash("md5")
    let downloadedBytes = 0
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      try {
        rmSync(destinationPath, { force: true })
      } catch {
        // Best effort cleanup, nothing more to do if it fails.
      }
      rejectPromise(error)
    }

    const request = httpsRequest(url, { method: "GET", headers: { Accept: "application/octet-stream" } }, (response) => {
      const statusCode = response.statusCode ?? 0
      const contentLength = Number(response.headers["content-length"])

      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        fail(new Error(`Download failed with status ${statusCode}`))
        return
      }
      if (Number.isFinite(contentLength) && (contentLength < 0 || contentLength > MAX_DOWNLOAD_BYTES)) {
        response.resume()
        fail(new Error("Download exceeds the size bound"))
        return
      }

      const writer = createWriteStream(destinationPath, { flags: "wx" })
      let lastLoggedPercent = 0

      response.on("data", (chunk: Buffer) => {
        downloadedBytes += chunk.length
        digest.update(chunk)
        if (downloadedBytes > MAX_DOWNLOAD_BYTES) {
          fail(new Error("Download exceeds the size bound"))
          return
        }
        if (Number.isFinite(contentLength) && contentLength > 0) {
          const percent = Math.floor((downloadedBytes / contentLength) * 100)
          if (percent >= lastLoggedPercent + 10) {
            lastLoggedPercent = percent
            console.log(`  ${percent}%`)
          }
        }
      })
      response.on("error", (error) => fail(error))
      writer.on("error", (error) => fail(error))
      writer.on("finish", () => {
        if (settled) return
        if (Number.isFinite(contentLength) && contentLength >= 0 && downloadedBytes !== contentLength) {
          fail(new Error("Downloaded artifact length mismatch"))
          return
        }
        const actualMd5 = digest.digest("hex")
        if (actualMd5 !== expectedMd5.toLowerCase()) {
          fail(new Error(`Downloaded artifact digest mismatch: expected ${expectedMd5}, got ${actualMd5}`))
          return
        }
        settled = true
        resolvePromise({ bytes: downloadedBytes })
      })

      response.pipe(writer)
    })

    request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => request.destroy(new Error("Download stalled")))
    request.on("error", (error) => fail(error))
    request.end()
  })
}

/**
 * Runs the installer with exactly the flags and spawn options RUN_INSTALLER
 * uses in src/ipc/handlers/pathsHandlers.ts.
 */
function runInstaller(installerPath: string, targetDir: string, timeoutMs?: number): Promise<InstallerRunResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now()
    const child = spawn(installerPath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/NOICONS", `/DIR=${targetDir}`], { shell: false, windowsHide: true })
    let settled = false
    let timedOut = false

    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            child.kill()
          }, timeoutMs)
        : undefined

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise({ exitCode, timedOut, durationMs: Date.now() - startedAt })
    }

    child.on("close", (code) => finish(code))
    child.on("error", () => finish(null))
  })
}

function seedUninstallKey(installLocation: string): void {
  execFileSync("reg", ["add", UNINSTALL_KEY_PATH, "/f"], { windowsHide: true })
  execFileSync("reg", ["add", UNINSTALL_KEY_PATH, "/v", "DisplayName", "/t", "REG_SZ", "/d", "Vintage Story", "/f"], { windowsHide: true })
  execFileSync("reg", ["add", UNINSTALL_KEY_PATH, "/v", "DisplayVersion", "/t", "REG_SZ", "/d", "1.18.0", "/f"], { windowsHide: true })
  execFileSync("reg", ["add", UNINSTALL_KEY_PATH, "/v", "UninstallString", "/t", "REG_SZ", "/d", `"${installLocation}\\unins000.exe"`, "/f"], { windowsHide: true })
  execFileSync("reg", ["add", UNINSTALL_KEY_PATH, "/v", "InstallLocation", "/t", "REG_SZ", "/d", installLocation, "/f"], { windowsHide: true })
}

function uninstallKeyExists(): boolean {
  const result = spawnSync("reg", ["query", UNINSTALL_KEY_PATH], { windowsHide: true })
  return result.status === 0
}

function removeUninstallKey(): void {
  try {
    execFileSync("reg", ["delete", UNINSTALL_KEY_PATH, "/f"], { windowsHide: true })
  } catch {
    // Best effort: the disposable runner is wiped after the job either way.
  }
}

function safeListDir(root: string, maxDepth = 2): string[] {
  const results: string[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      results.push(relative(root, full))
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return results
}

function writeReport(report: unknown, workDir: string): string {
  const reportDir = join(workDir, "report")
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, "windows-conformance-report.json"), JSON.stringify(report, null, 2))
  return reportDir
}

async function runScenario2(installerPath: string, workDir: string, version: string, fileName: string): Promise<Record<string, unknown>> {
  const targetDir = join(workDir, "scenario-2-seeded-key")
  const sentinelOldLocation = join(workDir, "scenario-2-old-location-sentinel")

  console.log("\nScenario 2: pre-seed the uninstall key InitializeSetup checks for, then run the installer silently.")
  seedUninstallKey(sentinelOldLocation)
  const keyPresentBeforeRun = uninstallKeyExists()

  const result = await runInstaller(installerPath, targetDir, SCENARIO_2_TIMEOUT_MS)

  const targetExecutableLanded = existsSync(join(targetDir, "Vintagestory.exe"))
  const sentinelExecutableLanded = existsSync(join(sentinelOldLocation, "Vintagestory.exe"))
  const keyPresentAfterRun = uninstallKeyExists()
  removeUninstallKey()

  const verdict = result.timedOut
    ? "Installer did not exit within the timeout: consistent with issue #8, InitializeSetup's MsgBox is not answered by /SUPPRESSMSGBOXES and blocks a silent run."
    : targetExecutableLanded
      ? "Installer exited and the game landed in the requested /DIR despite the seeded key."
      : sentinelExecutableLanded
        ? "Installer exited and silently redirected the install to the seeded InstallLocation instead of /DIR: reproduces issue #8's redirect risk."
        : "Installer exited without landing the game in either the requested folder or the seeded old location."

  return {
    scenario: "seeded-uninstall-key",
    version,
    fileName,
    uninstallKeyPath: UNINSTALL_KEY_PATH,
    keyPresentBeforeRun,
    keyPresentAfterRun,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    targetDir,
    targetExecutableLanded,
    sentinelOldLocation,
    sentinelExecutableLanded,
    targetListing: safeListDir(targetDir),
    sentinelListing: safeListDir(sentinelOldLocation),
    verdict
  }
}

async function main(): Promise<void> {
  const version = process.env.RIFT_WINDOWS_VERSION?.trim() || DEFAULT_VERSION
  const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), "rift-e2e")
  mkdirSync(workDir, { recursive: true })

  console.log(`Resolving the Windows installer for ${version} against the live catalog...`)
  const catalog = await fetchCatalog()
  if (!isRecord(catalog)) throw new Error("Catalog response was not an object")
  const versionEntry = catalog[version]
  if (!isRecord(versionEntry)) throw new Error(`Version ${version} was not found in the catalog`)
  const windowsEntry = asCatalogPlatformEntry(versionEntry.windows)
  if (!windowsEntry) throw new Error(`No Windows installer entry for version ${version}`)

  const fileName = assertSafeFileName(windowsEntry.filename)
  const downloadUrl = assertAllowedDownloadUrl(windowsEntry.cdnUrl)
  const installerPath = join(workDir, fileName)

  console.log(`Downloading ${fileName} (${windowsEntry.filesize}) from ${downloadUrl.toString()}`)
  const download = await downloadFile(downloadUrl, installerPath, windowsEntry.md5)
  console.log(`Downloaded ${download.bytes} bytes, md5 matches the catalog.`)

  console.log("\nScenario 1: clean install into an empty folder.")
  const scenario1TargetDir = join(workDir, "scenario-1-clean-install")
  const scenario1Result = await runInstaller(installerPath, scenario1TargetDir)
  const scenario1ExecutableLanded = existsSync(join(scenario1TargetDir, "Vintagestory.exe"))

  const scenario1Report = {
    scenario: "clean-install",
    version,
    fileName,
    exitCode: scenario1Result.exitCode,
    durationMs: scenario1Result.durationMs,
    targetDir: scenario1TargetDir,
    executableLanded: scenario1ExecutableLanded,
    targetListing: safeListDir(scenario1TargetDir)
  }
  console.log(JSON.stringify(scenario1Report, null, 2))

  if (!scenario1ExecutableLanded) {
    const reportDir = writeReport({ scenario1: scenario1Report, scenario2: null }, workDir)
    console.error(`\nFAIL: Vintagestory.exe did not land in ${scenario1TargetDir}. Report at ${reportDir}.`)
    process.exitCode = 1
    return
  }

  let scenario2Report: Record<string, unknown>
  try {
    scenario2Report = await runScenario2(installerPath, workDir, version, fileName)
  } catch (error) {
    scenario2Report = { scenario: "seeded-uninstall-key", error: error instanceof Error ? error.message : String(error) }
  }
  console.log(JSON.stringify(scenario2Report, null, 2))

  const reportDir = writeReport({ scenario1: scenario1Report, scenario2: scenario2Report }, workDir)
  console.log(`\nReport written to ${reportDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
