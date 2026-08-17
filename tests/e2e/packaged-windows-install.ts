/**
 * Packaged Windows install conformance check, run by hand from the
 * packaged-windows-conformance workflow. Sibling of windows-install.ts, and
 * deliberately not a replacement for it.
 *
 * windows-install.ts proves the Windows install path from SOURCE: it imports
 * runInnoExtraction directly and drives it under `tsx`, so the extractor's own
 * logic is exercised but nothing around it is. Everything that only exists once
 * electron-builder has packed the app stays untested there: the worker modules
 * are resolved through electron-vite's `?modulePath` output rather than from
 * `src/`, `app.asar` changes how a path inside the bundle resolves,
 * `asarUnpack` decides whether the 7-Zip binary is reachable at all, and the
 * Electron fuses in electron-builder.yml are only applied to the packaged
 * binary. A beta.1 tester reporting that every version install "fails to
 * unpack" (issue #119) is a report about that layer, not about the extractor,
 * and no check in this repo covered it.
 *
 * So this script never imports the launcher's install code. It launches the
 * packaged executable the workflow just built, attaches to it over the Chrome
 * DevTools Protocol, and calls the real preload API from inside the real
 * renderer, which means every call travels the same contextBridge, the same
 * `ipcMain.handle`, the same path policy and the same worker spawn a player's
 * click travels. The equivalent run has already been done by hand against the
 * published Linux AppImage, where the download and the extraction both
 * succeeded through the packaged app's own IPC; this is that session turned
 * into something CI can repeat on Windows.
 *
 * The flow mirrors AddVersion.tsx exactly, one preload call at a time:
 *
 * 1. `configManager.getConfig()` for `defaultVersionsFolder`, because
 *    useVersionInstallFolder.ts builds the install folder out of it and
 *    src/ipc/pathPolicy.ts only admits paths under the folders the config
 *    names. A folder picked any other way is refused as "Unmanaged output
 *    path" before anything is written.
 * 2. `pathsManager.formatPath([defaultVersionsFolder, version])`, which is the
 *    same join useVersionInstallFolder.ts performs.
 * 3. `pathsManager.downloadOnPath(id, cdnUrl, targetFolder, fileName)`, the
 *    call TaskManagerContext's startDownload makes. This step is not optional
 *    scaffolding: RUN_INSTALLER calls assertVerifiedArtifact, which only knows
 *    about files DOWNLOAD_ON_PATH recorded in the same main-process session,
 *    so an installer placed on disk by this script instead would be refused.
 * 4. `pathsManager.runInstaller(id, downloadedPath, targetFolder, true)`, the
 *    call startInstall makes. RUN_INSTALLER extracts the installer's payload
 *    rather than running it (EXTRACT_INSTALLER_PAYLOAD in pathsHandlers.ts),
 *    so this is the packaged-app proof of the path PR #88 added, and `true`
 *    for deleteInstaller is what createInstallPorts passes for a real install.
 *
 * Then the assertions are made from Node, against the same disk: Vintagestory.exe
 * at the target root (what src/domain/versions/gameExecutable.ts checks) and the
 * assets/version-<v>.txt marker. The marker is safe to require here because this
 * script always resolves the catalog's latest stable; docs/vintage-story-quirks.md
 * records that it does not exist in 1.18.15 and older, so anything that ever
 * pins an older version through this script has to drop that assertion.
 *
 * The report is written after every phase, not just on a clean exit, for the
 * reason windows-install.ts's persistReport comment gives: a run killed by the
 * job ceiling must still leave evidence behind. The app's stdout and stderr
 * ride along in it, because a packaged app that fails to reach its window has
 * nothing else to say for itself.
 *
 * The CI guard below matches windows-install.ts: this downloads and unpacks
 * most of a gigabyte and leaves a launcher process running until the finally
 * block gets it, which is not something to do to a machine by accident.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync, type Dirent } from "node:fs"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { assertAllowedApiUrl, assertAllowedDownloadUrl, assertSafeFileName, isRecord, MAX_RESPONSE_BYTES } from "../../src/ipc/validation"
import { buildInstallerTreeKillCommand, shouldKillInstallerTree } from "../../src/ipc/handlers/installerTimeoutOutcome"

if (!process.env.CI) {
  console.error("Refusing to run outside CI: this launches the packaged launcher, downloads a full game version and unpacks it. Run it only through the packaged-windows-conformance workflow.")
  process.exit(1)
}

if (process.platform !== "win32") {
  console.error("This script only makes sense on Windows: it drives the packaged Windows build through RUN_INSTALLER, which refuses to run anywhere else.")
  process.exit(1)
}

const CATALOG_URL = "https://api.vintagestory.at/stable.json"
/**
 * Fixed rather than picked at random so a failed run leaves an obvious thing
 * to look for in the report, and high enough not to collide with anything the
 * runner image starts on its own.
 */
const REMOTE_DEBUGGING_PORT = 9250
/** How long the packaged app gets to reach its `app://` page before the run is called a launch failure. */
const APP_READY_TIMEOUT_MS = 90_000
const APP_READY_POLL_INTERVAL_MS = 500
const CDP_CONNECT_TIMEOUT_MS = 15_000
/** Short calls that only cross the bridge and come straight back. */
const CDP_CALL_TIMEOUT_MS = 60_000
/**
 * Both bounds are deliberately tighter than the main process's own
 * (DOWNLOAD_ON_PATH gets 45 minutes and RUN_INSTALLER 30 in
 * WORKER_TIMEOUTS_MS): this script has to fail, write its report and let the
 * artifact upload run inside the job's own ceiling, which is the mistake
 * issue #55's first windows-conformance run made.
 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000
const INSTALL_TIMEOUT_MS = 10 * 60 * 1_000
/** Kept per stream so a chatty app cannot grow the report without bound. */
const MAX_CAPTURED_OUTPUT_CHARS = 64 * 1024

type CatalogPlatformEntry = {
  filename: string
  /** A human string such as "590.5 MB", never a byte count: see docs/vintage-story-quirks.md. Carried for the report only, never parsed. */
  filesize: string
  md5: string
  cdnUrl: string
}

type CdpSocket = {
  addEventListener(type: "open", listener: () => void): void
  addEventListener(type: "close", listener: () => void): void
  addEventListener(type: "error", listener: (event: unknown) => void): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  send(data: string): void
  close(): void
}

/**
 * Node 22 ships a WHATWG WebSocket as a global, which is the whole reason this
 * script needs no dependency for its DevTools client. It is declared here
 * rather than imported because @types/node 20 (what package.json pins) has no
 * declaration for it yet and the e2e tsconfig loads no DOM lib; the runtime
 * value is the real global either way.
 */
declare const WebSocket: new (url: string) => CdpSocket

type CdpConnection = {
  send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  close(): void
}

type AppProcess = {
  child: ChildProcessWithoutNullStreams
  readStdout(): string
  readStderr(): string
}

type Report = {
  phase: string
  exePath: string | null
  scratchAppData: string
  /** What the app itself says its userData folder is, which is the only honest record of whether the scratch redirection took. */
  userDataPath: string | null
  defaultVersionsFolder: string | null
  version: string | null
  fileName: string | null
  fileSize: string | null
  downloadUrl: string | null
  targetFolder: string | null
  downloadedPath: string | null
  installResult: unknown
  executableLanded: boolean | null
  versionMarkerRelativePath: string | null
  versionMarkerLanded: boolean | null
  targetListing: string[] | null
  durationsMs: Record<string, number>
  appStdout: string
  appStderr: string
  failed: boolean | null
  verdict: string | null
}

function asCatalogPlatformEntry(value: unknown): CatalogPlatformEntry | undefined {
  if (!isRecord(value)) return undefined
  const urls = value.urls
  if (typeof value.filename !== "string" || typeof value.filesize !== "string" || typeof value.md5 !== "string" || !isRecord(urls) || typeof urls.cdn !== "string") return undefined
  return { filename: value.filename, filesize: value.filesize, md5: value.md5, cdnUrl: urls.cdn }
}

/** Scans the catalog for the version whose Windows entry is flagged `latest: 1`, which is how the API marks the current stable release. */
function resolveLatestWindowsVersion(catalog: Record<string, unknown>): { version: string; entry: CatalogPlatformEntry } {
  for (const [version, versionEntry] of Object.entries(catalog)) {
    if (!isRecord(versionEntry)) continue
    const windowsRaw = versionEntry.windows
    if (!isRecord(windowsRaw) || windowsRaw.latest !== 1) continue
    const entry = asCatalogPlatformEntry(windowsRaw)
    if (entry) return { version, entry }
  }
  throw new Error("No catalog entry has a Windows build flagged as latest")
}

/**
 * Reads the live catalog from this script rather than from the page. The
 * renderer's own catalog fetch is not what issue #119 is about, and resolving
 * the version out here keeps the CDP surface down to the four install calls
 * this run exists to prove.
 */
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

/** One GET against the DevTools HTTP endpoint on loopback. Plain node:http, no URL policy: the host, port and path are all literals in this file. */
function fetchDevToolsTargets(): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({ host: "127.0.0.1", port: REMOTE_DEBUGGING_PORT, path: "/json", method: "GET" }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk: string) => {
        body += chunk
      })
      response.on("error", (error) => rejectPromise(error))
      response.on("end", () => {
        try {
          resolvePromise(JSON.parse(body))
        } catch {
          rejectPromise(new Error("DevTools target list was not valid JSON"))
        }
      })
    })

    request.setTimeout(5_000, () => request.destroy(new Error("DevTools target list request stalled")))
    request.on("error", (error) => rejectPromise(error))
    request.end()
  })
}

/**
 * Finds the launcher's own window among the DevTools targets.
 *
 * `app://renderer/index.html` is what main/index.ts loads in a packaged build
 * (the privileged custom protocol it registers instead of `file://`), so
 * matching on the scheme is what tells the real window apart from any
 * about:blank or worker target that shows up first.
 */
function findAppPageTarget(targets: unknown): { url: string; webSocketDebuggerUrl: string } | undefined {
  if (!Array.isArray(targets)) return undefined
  for (const target of targets) {
    if (!isRecord(target)) continue
    const { type, url, webSocketDebuggerUrl } = target
    if (type !== "page" || typeof url !== "string" || typeof webSocketDebuggerUrl !== "string") continue
    if (url.startsWith("app://")) return { url, webSocketDebuggerUrl }
  }
  return undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

/**
 * Locates the executable electron-builder just produced.
 *
 * `dist/win-unpacked/RiftLauncher.exe` is what `--win --x64 --dir` writes with
 * this repo's electron-builder.yml (`win.executableName: RiftLauncher`, no
 * `directories.output` override), but the folder name carries the architecture
 * on anything other than x64, so every `*-unpacked` folder is considered rather
 * than only the default name.
 */
function resolvePackagedExecutable(): string {
  const override = process.env.RIFT_PACKAGED_APP_EXE?.trim()
  if (override) {
    if (!existsSync(override)) throw new Error(`RIFT_PACKAGED_APP_EXE points at ${override}, which does not exist`)
    return override
  }

  const distDir = join(process.cwd(), "dist")
  if (!existsSync(distDir)) throw new Error("No dist folder: run `npm run build` and `npx electron-builder --win --x64 --dir` before this script")

  const candidates = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-unpacked"))
    .map((entry) => join(distDir, entry.name, "RiftLauncher.exe"))
    .filter((candidate) => existsSync(candidate))

  const [exePath] = candidates
  if (!exePath) throw new Error(`No RiftLauncher.exe under any *-unpacked folder in ${distDir}`)
  return exePath
}

/**
 * Starts the packaged app with the DevTools port open and its stdio captured.
 *
 * The scratch APPDATA is a best effort at hermeticity, not a guarantee, and
 * the script never relies on it: main/index.ts pins userData to
 * `join(app.getPath("appData"), "VSLauncher")`, and on Windows that appData
 * comes from the shell's known-folder API rather than from the environment, so
 * the redirection may simply not take. Everything this run touches is derived
 * from what the app reports back instead (`getCurrentUserDataPath` and the
 * config's own `defaultVersionsFolder`), and the report records both so a
 * reader can see where the run actually wrote. The runner is disposable either
 * way.
 *
 * `UPDATE=false` is main/index.ts's own switch for the auto-updater check, off
 * here so a release lookup cannot add noise or a five-second stall to a run
 * that has nothing to do with updates.
 */
function launchApp(exePath: string, scratchAppData: string): AppProcess {
  const child = spawn(exePath, [`--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`], {
    shell: false,
    windowsHide: true,
    env: { ...process.env, APPDATA: scratchAppData, LOCALAPPDATA: join(scratchAppData, "Local"), UPDATE: "false" }
  })

  let stdout = ""
  let stderr = ""
  const append = (buffer: string, chunk: string): string => (buffer.length >= MAX_CAPTURED_OUTPUT_CHARS ? buffer : (buffer + chunk).slice(0, MAX_CAPTURED_OUTPUT_CHARS))

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout = append(stdout, chunk)
  })
  child.stderr.on("data", (chunk: string) => {
    stderr = append(stderr, chunk)
  })

  return { child, readStdout: () => stdout, readStderr: () => stderr }
}

/**
 * Kills the launcher's whole process tree.
 *
 * Same reasoning as buildInstallerTreeKillCommand's own comment: a packaged
 * Electron app is a parent plus a renderer, a GPU process and a utility
 * process, and signalling only the pid `spawn` returned leaves the rest of
 * them behind on the runner.
 */
function killApp(app: AppProcess): void {
  const pid = app.child.pid
  if (!shouldKillInstallerTree(process.platform, pid)) return
  const { command, args } = buildInstallerTreeKillCommand(pid)
  spawnSync(command, args, { windowsHide: true })
}

/** A tiny DevTools client over Node's built-in WebSocket: request/response by id, nothing else. The protocol events this run would receive are all ignored. */
function connectCdp(webSocketDebuggerUrl: string): Promise<CdpConnection> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
    let nextId = 1
    let closed = false
    let opened = false

    const connectTimer = setTimeout(() => {
      if (opened) return
      socket.close()
      rejectPromise(new Error(`DevTools WebSocket did not open within ${CDP_CONNECT_TIMEOUT_MS}ms`))
    }, CDP_CONNECT_TIMEOUT_MS)

    const failAllPending = (error: Error): void => {
      for (const entry of [...pending.values()]) entry.reject(error)
      pending.clear()
    }

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      let message: unknown
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!isRecord(message) || typeof message.id !== "number") return

      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)

      const error = message.error
      if (isRecord(error)) {
        entry.reject(new Error(`DevTools command failed: ${typeof error.message === "string" ? error.message : JSON.stringify(error)}`))
        return
      }
      entry.resolve(isRecord(message.result) ? message.result : {})
    })

    socket.addEventListener("close", () => {
      closed = true
      clearTimeout(connectTimer)
      failAllPending(new Error("DevTools WebSocket closed before the command answered: the launcher process is probably gone"))
    })

    socket.addEventListener("error", () => {
      if (!opened) {
        clearTimeout(connectTimer)
        rejectPromise(new Error("DevTools WebSocket errored before it opened"))
        return
      }
      failAllPending(new Error("DevTools WebSocket errored"))
    })

    socket.addEventListener("open", () => {
      opened = true
      clearTimeout(connectTimer)
      resolvePromise({
        send: (method, params, timeoutMs) =>
          new Promise((resolveSend, rejectSend) => {
            if (closed) {
              rejectSend(new Error("DevTools WebSocket is already closed"))
              return
            }

            const id = nextId++
            const timer = setTimeout(() => {
              pending.delete(id)
              rejectSend(new Error(`${method} did not answer within ${timeoutMs}ms`))
            }, timeoutMs)

            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer)
                resolveSend(value)
              },
              reject: (error) => {
                clearTimeout(timer)
                rejectSend(error)
              }
            })

            socket.send(JSON.stringify({ id, method, params }))
          }),
        close: () => {
          closed = true
          socket.close()
        }
      })
    })
  })
}

/**
 * Builds the expression Runtime.evaluate runs.
 *
 * The arguments go over as a JSON string the page parses, rather than being
 * pasted into the source: every value here is a path or a URL, and a Windows
 * path is full of backslashes that would otherwise have to survive being read
 * as JavaScript escapes.
 */
function buildExpression(source: string, args: readonly unknown[]): string {
  return `(${source})(...JSON.parse(${JSON.stringify(JSON.stringify(args))}))`
}

function describeException(exceptionDetails: Record<string, unknown>): string {
  const exception = exceptionDetails.exception
  if (isRecord(exception) && typeof exception.description === "string") return exception.description
  if (isRecord(exception) && typeof exception.value === "string") return exception.value
  return typeof exceptionDetails.text === "string" ? exceptionDetails.text : "the page threw a value it could not describe"
}

/** Runs one async function inside the launcher's renderer and brings its resolved value back by value. */
async function evaluateInPage<T>(cdp: CdpConnection, source: string, args: readonly unknown[], timeoutMs: number): Promise<T> {
  const response = await cdp.send("Runtime.evaluate", { expression: buildExpression(source, args), awaitPromise: true, returnByValue: true }, timeoutMs)

  const exceptionDetails = response.exceptionDetails
  if (isRecord(exceptionDetails)) throw new Error(describeException(exceptionDetails))

  const result = response.result
  if (!isRecord(result)) throw new Error("Runtime.evaluate answered without a result object")
  return result.value as T
}

/**
 * The preload surface has to be there before anything is asked of it.
 *
 * A page target can show up in the DevTools list while its execution context
 * is still being swapped for the one the `app://` navigation creates, so this
 * is a poll and not a single check, and an evaluate that throws mid-swap is
 * treated as "not ready yet" rather than as a failure.
 */
const BRIDGE_READY_SOURCE = `() => typeof window.api?.configManager?.getConfig === "function" && typeof window.api?.pathsManager?.downloadOnPath === "function" && typeof window.api?.pathsManager?.runInstaller === "function"`

/** getConfig is how AddVersion.tsx learns where versions go; getCurrentUserDataPath is recorded so the report says where this run actually wrote. */
const READ_ENVIRONMENT_SOURCE = `async () => {
  const config = await window.api.configManager.getConfig()
  const userDataPath = await window.api.pathsManager.getCurrentUserDataPath()
  return { defaultVersionsFolder: config.defaultVersionsFolder, userDataPath }
}`

/** The same join useVersionInstallFolder.ts does, over the same FORMAT_PATH handler. */
const FORMAT_PATH_SOURCE = `async (folder, version) => window.api.pathsManager.formatPath([folder, version])`

/** TaskManagerContext's startDownload, minus the task bookkeeping the UI keeps for itself. */
const DOWNLOAD_SOURCE = `async (id, url, outputPath, fileName) => window.api.pathsManager.downloadOnPath(id, url, outputPath, fileName)`

/** TaskManagerContext's startInstall. `true` for deleteInstaller is what createInstallPorts passes on a real install, so the run leaves the folder in the state a player's install leaves it. */
const RUN_INSTALLER_SOURCE = `async (id, filePath, outputPath) => window.api.pathsManager.runInstaller(id, filePath, outputPath, true)`

async function waitForAppPage(app: AppProcess): Promise<{ url: string; webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + APP_READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (app.child.exitCode !== null) break

    try {
      const target = findAppPageTarget(await fetchDevToolsTargets())
      if (target) return target
    } catch {
      // The DevTools endpoint is not listening yet, which is the normal state
      // for the first second or so of a cold start.
    }

    await delay(APP_READY_POLL_INTERVAL_MS)
  }

  const exited = app.child.exitCode !== null ? ` The process exited with code ${app.child.exitCode}.` : ""
  throw new Error(`The packaged app never exposed an app:// page on the DevTools port within ${APP_READY_TIMEOUT_MS}ms.${exited}\nstdout:\n${app.readStdout()}\nstderr:\n${app.readStderr()}`)
}

async function waitForBridge(cdp: CdpConnection): Promise<void> {
  const deadline = Date.now() + APP_READY_TIMEOUT_MS
  let lastError = "the preload API never appeared on window"

  while (Date.now() < deadline) {
    try {
      if (await evaluateInPage<boolean>(cdp, BRIDGE_READY_SOURCE, [], CDP_CALL_TIMEOUT_MS)) return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(APP_READY_POLL_INTERVAL_MS)
  }

  throw new Error(`The packaged app's preload bridge was not usable within ${APP_READY_TIMEOUT_MS}ms: ${lastError}`)
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

function writeReport(report: Report, workDir: string): string {
  const reportDir = join(workDir, "report")
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, "packaged-windows-conformance-report.json"), JSON.stringify(report, null, 2))
  return reportDir
}

async function main(): Promise<void> {
  const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), "rift-packaged-e2e")
  const scratchAppData = join(workDir, "appdata")
  mkdirSync(scratchAppData, { recursive: true })

  const report: Report = {
    phase: "starting",
    exePath: null,
    scratchAppData,
    userDataPath: null,
    defaultVersionsFolder: null,
    version: null,
    fileName: null,
    fileSize: null,
    downloadUrl: null,
    targetFolder: null,
    downloadedPath: null,
    installResult: null,
    executableLanded: null,
    versionMarkerRelativePath: null,
    versionMarkerLanded: null,
    targetListing: null,
    durationsMs: {},
    appStdout: "",
    appStderr: "",
    failed: null,
    verdict: null
  }

  // Written after every phase, same as windows-install.ts: a run the job
  // ceiling kills has to leave its evidence behind anyway.
  let app: AppProcess | undefined
  const persistReport = (): string => {
    if (app) {
      report.appStdout = app.readStdout()
      report.appStderr = app.readStderr()
    }
    return writeReport(report, workDir)
  }
  persistReport()

  try {
    report.phase = "resolving-catalog"
    persistReport()

    console.log("Resolving the latest stable Windows build against the live catalog...")
    const catalog = await fetchCatalog()
    if (!isRecord(catalog)) throw new Error("Catalog response was not an object")

    const { version, entry } = resolveLatestWindowsVersion(catalog)
    const fileName = assertSafeFileName(entry.filename)
    const downloadUrl = assertAllowedDownloadUrl(entry.cdnUrl).toString()
    report.version = version
    report.fileName = fileName
    report.fileSize = entry.filesize
    report.downloadUrl = downloadUrl
    console.log(`Latest stable is ${version} (${fileName}, ${entry.filesize}).`)

    report.phase = "launching-packaged-app"
    persistReport()

    const exePath = resolvePackagedExecutable()
    report.exePath = exePath
    console.log(`Launching ${exePath} with --remote-debugging-port=${REMOTE_DEBUGGING_PORT}`)

    const launchedAt = Date.now()
    app = launchApp(exePath, scratchAppData)
    const target = await waitForAppPage(app)
    report.durationsMs.launch = Date.now() - launchedAt
    console.log(`The launcher's window is up at ${target.url} after ${report.durationsMs.launch}ms.`)

    report.phase = "attaching-devtools"
    persistReport()

    const cdp = await connectCdp(target.webSocketDebuggerUrl)
    await waitForBridge(cdp)
    console.log("Attached, and the preload API is exposed.")

    report.phase = "reading-config"
    persistReport()

    const environment = await evaluateInPage<{ defaultVersionsFolder: string; userDataPath: string }>(cdp, READ_ENVIRONMENT_SOURCE, [], CDP_CALL_TIMEOUT_MS)
    report.userDataPath = environment.userDataPath
    report.defaultVersionsFolder = environment.defaultVersionsFolder
    console.log(`userData is ${environment.userDataPath}, versions go under ${environment.defaultVersionsFolder}.`)

    const targetFolder = await evaluateInPage<string>(cdp, FORMAT_PATH_SOURCE, [environment.defaultVersionsFolder, version], CDP_CALL_TIMEOUT_MS)
    report.targetFolder = targetFolder
    report.phase = "downloading"
    persistReport()

    console.log(`Downloading ${fileName} into ${targetFolder} through the packaged app's own DOWNLOAD_ON_PATH...`)
    const downloadStartedAt = Date.now()
    const downloadedPath = await evaluateInPage<string>(cdp, DOWNLOAD_SOURCE, [randomUUID(), downloadUrl, targetFolder, fileName], DOWNLOAD_TIMEOUT_MS)
    report.durationsMs.download = Date.now() - downloadStartedAt
    report.downloadedPath = downloadedPath
    report.phase = "installing"
    persistReport()
    console.log(`Downloaded to ${downloadedPath} in ${report.durationsMs.download}ms.`)

    console.log("Unpacking it through the packaged app's own RUN_INSTALLER...")
    const installStartedAt = Date.now()
    const installResult = await evaluateInPage<InstallerRunResult>(cdp, RUN_INSTALLER_SOURCE, [randomUUID(), downloadedPath, targetFolder], INSTALL_TIMEOUT_MS)
    report.durationsMs.install = Date.now() - installStartedAt
    report.installResult = installResult
    report.phase = "asserting"
    persistReport()

    const versionMarkerRelativePath = join("assets", `version-${version}.txt`)
    const executableLanded = existsSync(join(targetFolder, "Vintagestory.exe"))
    const versionMarkerLanded = existsSync(join(targetFolder, versionMarkerRelativePath))
    report.versionMarkerRelativePath = versionMarkerRelativePath
    report.executableLanded = executableLanded
    report.versionMarkerLanded = versionMarkerLanded
    report.targetListing = safeListDir(targetFolder)

    const installOk = isRecord(installResult) && installResult.ok === true
    report.failed = !installOk || !executableLanded || !versionMarkerLanded
    report.verdict = !installOk
      ? `RUN_INSTALLER refused the install through the packaged app (${isRecord(installResult) && typeof installResult.reason === "string" ? installResult.reason : "no reason on the wire"}).`
      : !executableLanded
        ? "RUN_INSTALLER reported ok but Vintagestory.exe did not land at the target root."
        : !versionMarkerLanded
          ? `RUN_INSTALLER reported ok but ${versionMarkerRelativePath} did not land.`
          : `The packaged app downloaded and unpacked ${version} through its own IPC: worker spawning, asar path resolution and the path policy all hold once electron-builder has packed the app.`

    report.phase = report.failed ? "failed" : "done"
    cdp.close()
  } catch (error) {
    report.failed = true
    report.verdict = error instanceof Error ? (error.stack ?? error.message) : String(error)
    report.phase = `${report.phase}-failed`
  } finally {
    if (app) killApp(app)
    const reportDir = persistReport()
    console.log(JSON.stringify({ ...report, appStdout: undefined, appStderr: undefined }, null, 2))
    if (report.failed) {
      console.error(`\nFAIL: ${report.verdict} Report at ${reportDir}.`)
      process.exitCode = 1
    } else {
      console.log(`\nReport written to ${reportDir}`)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
