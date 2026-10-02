import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import type { OptimumManifest } from "@domain/optimum/manifest"
import { hostRid } from "@domain/optimum/plan"

/**
 * What each of the five moved worker/archive chunks does when it cannot be loaded.
 *
 * `src/ipc/handlers/worldsHandlers.ts`, `src/ipc/optimumInstall.ts` and `src/ipc/optimumManifest.ts`
 * load their worker chunks with `await import(...)` now instead of at module scope, so a chunk that
 * is missing, corrupt or throws at module scope is a rejection at the call site rather than a
 * failure to load the whole handler module. These tests drive that: the specifiers below reject
 * when their name is in the per-test `broken` list, which is what a chunk that cannot be loaded does
 * to the import.
 *
 * The property under test is not "the feature works" but "the failure is the same failure the
 * static import produced": a calm refusal with no partial state, and a handler module that still
 * loads and still answers.
 *
 * `vi.doMock` rather than `vi.mock`: vitest caches a `vi.mock` factory's result per specifier for
 * the whole file, so `vi.resetModules()` alone cannot make the same specifier throw in one test and
 * resolve in the next. `doMock` re-registers the factory on every call.
 */
type ChunkName = "compression" | "archiveValidation" | "extraction" | "download"

const CHUNK_SPECIFIERS: Record<ChunkName, string> = {
  compression: "@src/ipc/workers/compression",
  archiveValidation: "@src/ipc/archiveValidation",
  extraction: "@src/ipc/workers/extraction",
  download: "@src/ipc/workers/download"
}

/**
 * Registers every worker-chunk specifier as a mock, with the ones named in `broken` rejecting on
 * import and the rest answering as the real chunk does for the one call the flow under test makes.
 */
function installChunkMocks(broken: readonly ChunkName[]): void {
  for (const name of Object.keys(CHUNK_SPECIFIERS) as ChunkName[]) {
    const specifier = CHUNK_SPECIFIERS[name]
    if (broken.includes(name)) {
      vi.doMock(specifier, () => {
        throw new Error(`simulated chunk load failure: ${specifier}`)
      })
      continue
    }
    if (name === "compression") vi.doMock(specifier, () => ({ runCompression: vi.fn(async () => undefined) }))
    else if (name === "archiveValidation") vi.doMock(specifier, () => ({ validateWorldBackupArchive: vi.fn(async () => undefined) }))
    else if (name === "extraction")
      vi.doMock(specifier, () => ({
        extractTarGz: vi.fn(async (_archivePath: string, outputPath: string) => {
          writeFileSync(join(outputPath, "World.vcdbs"), "restored", "utf8")
        })
      }))
    else vi.doMock(specifier, () => ({ runDownload: vi.fn(async () => join("/nonexistent", "manifest.json")) }))
  }
}

const CURRENT_SCHEMA = 6
const RID = hostRid(process.platform, process.arch)

let temporaryRoot: string
let userDataPath: string
let installationsRoot: string
let backupsFolder: string

type WorldsHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

function handler(channel: string): WorldsHandler {
  return getIpcHandler<WorldsHandler>(channel)
}

function installation(id: string, path: string, worldBackups: WorldBackupType[] = []): InstallationType {
  return {
    id,
    name: id,
    icon: "",
    path,
    version: "1.22.7",
    gameVersionId: `version-${id}`,
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    worldBackups,
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: ""
  }
}

function writeConfig(installations: InstallationType[]): void {
  writeFileSync(
    join(userDataPath, "config.json"),
    JSON.stringify({
      schemaVersion: CURRENT_SCHEMA,
      lastUsedInstallation: null,
      defaultInstallationsFolder: installationsRoot,
      defaultVersionsFolder: join(temporaryRoot, "versions"),
      backupsFolder,
      window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
      accounts: [],
      activeAccountId: null,
      installations,
      gameVersions: [],
      favMods: [],
      customIcons: []
    }),
    "utf8"
  )
}

/** Loads a fresh copy of the worlds handler module under whatever mocks are registered right now. */
async function loadWorldsHandlers(): Promise<void> {
  vi.resetModules()
  await import("@src/ipc/handlers/worldsHandlers")
}

/** Every `.rift-world-restore-*` staging folder left in the Saves folder. */
function restoreTempDirs(savesPath: string): string[] {
  return readdirSync(savesPath).filter((name) => name.startsWith(".rift-world-restore-"))
}

/** A world in `install-a` plus the config that names it, which every backup or restore flow needs. */
function seedInstallationWithWorld(): { savesPath: string; worldPath: string } {
  const installationPath = join(installationsRoot, "install-a")
  const savesPath = join(installationPath, "Saves")
  const worldPath = join(savesPath, "World.vcdbs")
  mkdirSync(savesPath, { recursive: true })
  writeFileSync(worldPath, "world", "utf8")
  writeConfig([installation("install-a", installationPath)])
  return { savesPath, worldPath }
}

/** The same, with one recorded backup archive the restore flow can be pointed at. */
function seedInstallationWithBackup(backupId: string): { savesPath: string; worldPath: string } {
  const seeded = seedInstallationWithWorld()
  const backupArchive = join(backupsFolder, "Worlds", `${backupId}.tar.gz`)
  mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
  writeFileSync(backupArchive, "dummy", "utf8")
  writeConfig([installation("install-a", join(installationsRoot, "install-a"), [{ id: backupId, date: 1, path: backupArchive, worldName: "World.vcdbs" }])])
  return seeded
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "dynamic-chunk-failure-"))
  userDataPath = join(temporaryRoot, "userData")
  installationsRoot = join(temporaryRoot, "installations")
  backupsFolder = join(temporaryRoot, "backups")
  mkdirSync(userDataPath, { recursive: true })
  mkdirSync(installationsRoot, { recursive: true })
  mkdirSync(join(temporaryRoot, "versions"), { recursive: true })
  setElectronUserDataPath(userDataPath)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("worlds handlers with an unloadable worker chunk", () => {
  it("rejects the import of a broken chunk and resolves an intact one, which is the whole simulation", async () => {
    installChunkMocks(["compression"])
    vi.resetModules()
    // Vitest wraps a throwing factory in its own error, with the factory's own error as `cause`.
    await assert.rejects(
      () => import("@src/ipc/workers/compression"),
      (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause
        return cause instanceof Error && cause.message.includes("simulated chunk load failure")
      }
    )

    installChunkMocks([])
    vi.resetModules()
    const intact = (await import("@src/ipc/workers/compression")) as { runCompression?: unknown }
    assert.equal(typeof intact.runCompression, "function")
  })

  it("backs the world up when nothing is broken, so the failure tests below are not a harness artifact", async () => {
    const { savesPath } = seedInstallationWithWorld()
    installChunkMocks([])
    await loadWorldsHandlers()

    const result = (await handler("worlds-backup")(await createTrustedEvent(), "install-a", "World.vcdbs")) as WorldBackupResult

    assert.equal(result.ok, true)
    expect(restoreTempDirs(savesPath)).toEqual([])
    const config = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    assert.equal(config.installations[0]?.worldBackups?.length, 1)
  })

  it("loads and registers the handler module even when every chunk it needs is broken", async () => {
    installChunkMocks(["compression", "archiveValidation", "extraction"])

    await loadWorldsHandlers()

    // The module-scope imports this change removed would have failed here instead, taking every
    // worlds channel down with them.
    assert.equal(typeof handler("worlds-backup"), "function")
    assert.equal(typeof handler("worlds-restore"), "function")
  })

  it("returns operation-failed and writes no archive when the compression chunk cannot load", async () => {
    seedInstallationWithWorld()
    installChunkMocks(["compression"])
    await loadWorldsHandlers()

    const result = await handler("worlds-backup")(await createTrustedEvent(), "install-a", "World.vcdbs")

    assert.deepEqual(result, { ok: false, reason: "operation-failed" })
    const config = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    expect(config.installations[0]?.worldBackups ?? []).toEqual([])
    const worldsBackupsFolder = join(backupsFolder, "Worlds")
    expect(existsSync(worldsBackupsFolder) ? readdirSync(worldsBackupsFolder) : []).toEqual([])
  })

  it("returns operation-failed and leaves no staging folder when the archiveValidation chunk cannot load", async () => {
    const { savesPath, worldPath } = seedInstallationWithBackup("backup-broken-validation")
    installChunkMocks(["archiveValidation"])
    await loadWorldsHandlers()

    const result = await handler("worlds-restore")(await createTrustedEvent(), "install-a", "backup-broken-validation")

    assert.deepEqual(result, { ok: false, reason: "operation-failed" })
    expect(restoreTempDirs(savesPath)).toEqual([])
    assert.equal(readFileSync(worldPath, "utf8"), "world")
  })

  it("returns operation-failed and leaves no staging folder when the extraction chunk cannot load", async () => {
    const { savesPath, worldPath } = seedInstallationWithBackup("backup-broken-extraction")
    installChunkMocks(["extraction"])
    await loadWorldsHandlers()

    const result = await handler("worlds-restore")(await createTrustedEvent(), "install-a", "backup-broken-extraction")

    assert.deepEqual(result, { ok: false, reason: "operation-failed" })
    expect(restoreTempDirs(savesPath)).toEqual([])
    assert.equal(readFileSync(worldPath, "utf8"), "world")
  })
})

describe("optimum manifest with an unloadable download chunk", () => {
  it("answers unreachable instead of rejecting, and retries on the next ask", async () => {
    if (RID === undefined) return // This host gets no Optimum manifest at all, so the import is never reached.
    installChunkMocks(["download"])

    vi.resetModules()
    const { getOptimumManifest } = await import("@src/ipc/optimumManifest")

    const first = await getOptimumManifest()
    assert.deepEqual(first, { ok: false, reason: "unreachable" })

    // The session cache is dropped on failure, so a second ask re-enters the import rather than
    // serving the rejection forever.
    const second = await getOptimumManifest()
    assert.deepEqual(second, { ok: false, reason: "unreachable" })
  })
})

describe("optimum overlay staging with an unloadable extraction chunk", () => {
  it("refuses overlay-unverified, clears the staging folder, and logs the cause instead of only blaming the download", async () => {
    // A real file at the published size and hash, so the archive gate passes and the run reaches the
    // import. The overlay folder holds a file no manifest names, which is what makes the pre-check
    // say "not staged yet" rather than short-circuiting into success.
    const archivePath = join(temporaryRoot, "Optimum-v0.3.14-linux-x64-overlay.tar.gz")
    writeFileSync(archivePath, "overlay bytes", "utf8")
    const archive = readFileSync(archivePath)
    const overlayDirectory = join(temporaryRoot, "overlay")
    mkdirSync(overlayDirectory, { recursive: true })
    writeFileSync(join(overlayDirectory, "leftover.txt"), "x", "utf8")

    const manifest: OptimumManifest = {
      manifestVersion: 1,
      optimumVersion: "0.3.14",
      supportedGameVersions: ["1.22.7"],
      rid: RID ?? "linux-x64",
      archive: { filename: "Optimum-v0.3.14-linux-x64-overlay.tar.gz", size: archive.length, sha256: createHash("sha256").update(archive).digest("hex") },
      targets: [],
      files: []
    }

    const realLogManager = await import("@src/utils/logManager")
    const logMessage = vi.fn()
    vi.doMock("@src/utils/logManager", () => ({ ...realLogManager, logMessage }))
    installChunkMocks(["extraction"])
    vi.resetModules()
    const { applyOptimumOverlay } = await import("@src/ipc/optimumInstall")

    const result = await applyOptimumOverlay({
      manifest,
      archivePath,
      overlayDirectory,
      gameDirectory: join(temporaryRoot, "game"),
      gameVersion: "1.22.7",
      platform: "linux"
    })

    assert.deepEqual(result, { ok: false, reason: "overlay-unverified" })
    assert.equal(existsSync(overlayDirectory), false)
    // The refusal the player sees is the same one a bad archive produces, so the log is the only
    // place the real cause survives. Without the catch binding the error this is one call, not two,
    // and the second line would be `getErrorMessage`'s non-Error fallback.
    const logged = logMessage.mock.calls.map((call) => String(call[1]))
    assert.match(logged.join("\n"), /Could not extract the downloaded overlay archive/)
    assert.equal(logged.length, 2)
    assert.notEqual(logged[1], "Operation failed")
    assert.notEqual(logged[1], "")

    vi.doUnmock("@src/utils/logManager")
  })
})
