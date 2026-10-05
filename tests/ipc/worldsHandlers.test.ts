import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

const compressionState = vi.hoisted(() => ({
  block: false,
  calls: [] as string[],
  release: [] as Array<() => void>
}))

const runCompression = vi.hoisted(() =>
  vi.fn(async ({ inputPath, outputPath, outputFileName }: { inputPath: string; outputPath: string; outputFileName: string }) => {
    compressionState.calls.push(inputPath)
    if (compressionState.block) await new Promise<void>((resolve) => compressionState.release.push(resolve))
    mkdirSync(outputPath, { recursive: true })
    writeFileSync(join(outputPath, outputFileName), "archive", "utf8")
  })
)

const extractTarGz = vi.hoisted(() =>
  vi.fn(async (_archivePath: string, outputPath: string) => {
    writeFileSync(join(outputPath, "World.vcdbs"), "restored", "utf8")
  })
)

const validateWorldBackupArchive = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@src/ipc/workers/compression", () => ({ runCompression }))
vi.mock("@src/ipc/workers/extraction", () => ({ extractTarGz }))
vi.mock("@src/ipc/archiveValidation", () => ({ validateWorldBackupArchive }))

const CURRENT_SCHEMA = 6
let temporaryRoot: string
let userDataPath: string
let installationsRoot: string
let backupsFolder: string
let markInstallationPlaying: typeof import("@src/ipc/installationActivity").markInstallationPlaying
let clearInstallationPlaying: typeof import("@src/ipc/installationActivity").clearInstallationPlaying
let tryAcquireInstallationOperation: typeof import("@src/ipc/installationActivity").tryAcquireInstallationOperation
let pathPolicy: typeof import("@src/ipc/pathPolicy")
let realAssertManagedPath: (typeof import("@src/ipc/pathPolicy"))["assertManagedPath"]
let assertManagedPathSpy: ReturnType<typeof vi.spyOn>
let assertManagedDeletionPathSpy: ReturnType<typeof vi.spyOn>

type WorldsHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

/** True when two files differing only by case can coexist, which is the only place a case-folding bug is observable. */
const caseSensitiveFileSystem = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "case-probe-"))
  try {
    writeFileSync(join(probe, "CaseProbe"), "upper", "utf8")
    return existsSync(join(probe, "caseprobe")) === false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

function installation(id: string, path: string, version = "1.22.7", worldBackups: WorldBackupType[] = []): InstallationType {
  return {
    id,
    name: id,
    icon: "",
    path,
    version,
    gameVersionId: `version-${id}`,
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    worldBackups: worldBackups,
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

function handler(channel: string): WorldsHandler {
  return getIpcHandler<WorldsHandler>(channel)
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition")
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "world-handlers-"))
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
  compressionState.block = false
  compressionState.calls = []
  compressionState.release = []
  runCompression.mockClear()
  extractTarGz.mockClear()
  validateWorldBackupArchive.mockReset()
  validateWorldBackupArchive.mockResolvedValue(undefined)

  vi.resetModules()
  pathPolicy = await import("@src/ipc/pathPolicy")
  realAssertManagedPath = pathPolicy.assertManagedPath
  assertManagedPathSpy = vi.spyOn(pathPolicy, "assertManagedPath")
  assertManagedDeletionPathSpy = vi.spyOn(pathPolicy, "assertManagedDeletionPath")
  ;({ markInstallationPlaying, clearInstallationPlaying, tryAcquireInstallationOperation } = await import("@src/ipc/installationActivity"))
  await import("@src/ipc/handlers/worldsHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("worlds IPC handlers", () => {
  it("registers every worlds channel and rejects an untrusted sender", async () => {
    const event = createUntrustedEvent()
    const channels = ["worlds-list", "worlds-backup", "worlds-restore", "worlds-delete", "worlds-delete-backup", "worlds-transfer"]

    for (const channel of channels) {
      await assert.rejects(() => handler(channel)(event, "install-a", "World.vcdbs", "install-b", "copy"), /Unauthorized IPC sender/)
    }
  })

  it("lists only safe world files from the configured Saves folder", async () => {
    const installationPath = join(installationsRoot, "install-a")
    const savesPath = join(installationPath, "Saves")
    mkdirSync(savesPath, { recursive: true })
    writeFileSync(join(savesPath, "World.vcdbs"), "world", "utf8")
    writeFileSync(join(savesPath, "default.vcdbs"), "default-world", "utf8")
    writeFileSync(join(savesPath, "notes.txt"), "not a world", "utf8")
    writeFileSync(join(savesPath, "unsafe.vcdbs "), "unsafe", "utf8")
    writeConfig([installation("install-a", installationPath, "1.22.7", [{ id: "backup-default", date: 1, path: join(backupsFolder, "Worlds", "backup-default.tar.gz"), worldName: "default.vcdbs" }])])

    const statWorld = statSync(join(savesPath, "World.vcdbs"))
    const statDefault = statSync(join(savesPath, "default.vcdbs"))

    const result = await handler("worlds-list")(await createTrustedEvent(), "install-a")

    const expectedWorlds = [
      {
        name: "World.vcdbs",
        size: statWorld.size,
        lastModified: statWorld.mtimeMs,
        isDefault: false,
        backupCount: 0
      },
      {
        name: "default.vcdbs",
        size: statDefault.size,
        lastModified: statDefault.mtimeMs,
        isDefault: true,
        backupCount: 1
      }
    ].sort((left, right) => right.lastModified - left.lastModified || left.name.localeCompare(right.name))

    assert.deepEqual(result, {
      ok: true,
      worlds: expectedWorlds
    })
  })

  it("refuses an unmanaged installation path", async () => {
    const installationPath = join(installationsRoot, "install-a")
    const actualPath = join(temporaryRoot, "outside-install")
    mkdirSync(join(actualPath, "Saves"), { recursive: true })
    symlinkSync(actualPath, installationPath, "junction")
    writeConfig([installation("install-a", installationPath)])

    const result = await handler("worlds-list")(await createTrustedEvent(), "install-a")

    assert.deepEqual(result, { ok: false, reason: "operation-failed" })
  })

  it.each([
    ["backup", "worlds-backup", "missing.vcdbs", "world-not-found"],
    ["delete", "worlds-delete", "missing.vcdbs", "world-not-found"],
    ["restore", "worlds-restore", "missing-backup", "archive-not-found"],
    ["transfer", "worlds-transfer", "missing.vcdbs", "world-not-found"]
  ])("%s rejects a world name that is not listed", async (_operation, channel, worldName, reason) => {
    const installationPath = join(installationsRoot, "install-a")
    mkdirSync(join(installationPath, "Saves"), { recursive: true })
    writeFileSync(join(installationPath, "Saves", "World.vcdbs"), "world", "utf8")
    writeConfig([installation("install-a", installationPath), installation("install-b", join(installationsRoot, "install-b"))])

    const args = channel === "worlds-transfer" ? ["install-a", worldName, "install-b", "copy"] : ["install-a", worldName]
    const result = await handler(channel)(await createTrustedEvent(), ...args)

    assert.deepEqual(result, { ok: false, reason })
  })

  it.each([
    ["backup", "worlds-backup", ["install-a", "../World.vcdbs"]],
    ["delete", "worlds-delete", ["install-a", "Saves/World.vcdbs"]],
    ["transfer", "worlds-transfer", ["install-a", "Saves/World.vcdbs", "install-b", "copy"]]
  ])("%s rejects a path with a separator in the world name", async (_operation, channel, args) => {
    const installationPath = join(installationsRoot, "install-a")
    mkdirSync(join(installationPath, "Saves"), { recursive: true })
    writeFileSync(join(installationPath, "Saves", "World.vcdbs"), "world", "utf8")
    writeConfig([installation("install-a", installationPath), installation("install-b", join(installationsRoot, "install-b"))])

    const result = await handler(channel)(await createTrustedEvent(), ...args)

    assert.deepEqual(result, { ok: false, reason: "world-not-found" })
  })

  it.skipIf(process.platform !== "linux")("prefers an exact world-name match when names differ only by case", async () => {
    const installationPath = join(installationsRoot, "install-a")
    const savesPath = join(installationPath, "Saves")
    mkdirSync(savesPath, { recursive: true })
    writeFileSync(join(savesPath, "World.vcdbs"), "upper", "utf8")
    writeFileSync(join(savesPath, "world.vcdbs"), "lower", "utf8")
    writeConfig([installation("install-a", installationPath)])

    const result = await handler("worlds-delete")(await createTrustedEvent(), "install-a", "world.vcdbs")

    assert.deepEqual(result, { ok: true })
    assert.equal(existsSync(join(savesPath, "World.vcdbs")), true)
    assert.equal(existsSync(join(savesPath, "world.vcdbs")), false)
  })

  it("refuses a world name that differs from the listed file only by case", async () => {
    const installationPath = join(installationsRoot, "install-a")
    const savesPath = join(installationPath, "Saves")
    mkdirSync(savesPath, { recursive: true })
    writeFileSync(join(savesPath, "World.vcdbs"), "upper", "utf8")
    writeConfig([installation("install-a", installationPath)])

    const result = await handler("worlds-delete")(await createTrustedEvent(), "install-a", "world.vcdbs")

    assert.deepEqual(result, { ok: false, reason: "world-not-found" })
    assert.equal(existsSync(join(savesPath, "World.vcdbs")), true)
  })

  it.skipIf(!caseSensitiveFileSystem)("restores beside a world whose name differs only by case instead of overwriting it", async () => {
    const installationPath = join(installationsRoot, "install-a")
    const savesPath = join(installationPath, "Saves")
    const archivePath = join(backupsFolder, "Worlds", "backup-case.tar.gz")
    mkdirSync(savesPath, { recursive: true })
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(join(savesPath, "world.vcdbs"), "survivor", "utf8")
    writeFileSync(archivePath, "archive", "utf8")
    writeConfig([installation("install-a", installationPath, "1.22.7", [{ id: "backup-case", date: 1, path: archivePath, worldName: "World.vcdbs" }])])

    const result = await handler("worlds-restore")(await createTrustedEvent(), "install-a", "backup-case")

    assert.deepEqual(result, { ok: true })
    assert.equal(readFileSync(join(savesPath, "world.vcdbs"), "utf8"), "survivor")
    assert.equal(readFileSync(join(savesPath, "World.vcdbs"), "utf8"), "restored")
  })

  it("counts backups only for the exact world name", async () => {
    const installationPath = join(installationsRoot, "install-a")
    const savesPath = join(installationPath, "Saves")
    mkdirSync(savesPath, { recursive: true })
    writeFileSync(join(savesPath, "World.vcdbs"), "world", "utf8")
    writeConfig([installation("install-a", installationPath, "1.22.7", [{ id: "backup-case", date: 1, path: join(backupsFolder, "Worlds", "backup-case.tar.gz"), worldName: "world.vcdbs" }])])

    const result = (await handler("worlds-list")(await createTrustedEvent(), "install-a")) as { ok: boolean; worlds: Array<{ name: string; backupCount: number }> }

    assert.equal(result.ok, true)
    assert.deepEqual(
      result.worlds.map((world) => [world.name, world.backupCount]),
      [["World.vcdbs", 0]]
    )
  })

  it("backs up, restores, deletes, and transfers a listed world", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    const targetPath = join(installationsRoot, "install-b")
    const sourceWorld = join(sourcePath, "Saves", "World.vcdbs")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    mkdirSync(join(targetPath, "Saves"), { recursive: true })
    writeFileSync(sourceWorld, "world", "utf8")
    writeConfig([installation("install-a", sourcePath), installation("install-b", targetPath, "1.22.8")])
    const event = await createTrustedEvent()

    const backupResult = (await handler("worlds-backup")(event, "install-a", "World.vcdbs")) as WorldBackupResult
    assert.equal(backupResult.ok, true)
    if (!backupResult.ok) return
    expect(assertManagedPathSpy).toHaveBeenCalledWith(sourceWorld, "world")
    const configAfterBackup = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    assert.equal(configAfterBackup.installations[0]?.worldBackups?.[0]?.id, backupResult.backup.id)

    const restoreResult = await handler("worlds-restore")(event, "install-a", backupResult.backup.id)
    assert.deepEqual(restoreResult, { ok: true })
    expect(validateWorldBackupArchive).toHaveBeenCalledWith(backupResult.backup.path, "World.vcdbs")
    assert.equal(readFileSync(sourceWorld, "utf8"), "restored")

    const transferResult = await handler("worlds-transfer")(event, "install-a", "World.vcdbs", "install-b", "copy")
    assert.deepEqual(transferResult, { ok: true, targetWorldName: "World.vcdbs", warning: "different-version" })
    expect(assertManagedPathSpy).toHaveBeenCalledWith(join(targetPath, "Saves", "World.vcdbs"), "destination world", { allowMissing: true })
    expect(existsSync(join(targetPath, "Saves", "World.vcdbs"))).toBe(true)

    const deleteResult = await handler("worlds-delete")(event, "install-a", "World.vcdbs")
    assert.deepEqual(deleteResult, { ok: true })
    expect(assertManagedDeletionPathSpy).toHaveBeenCalledWith(sourceWorld)
    expect(existsSync(sourceWorld)).toBe(false)
  })

  it("returns operation-failed instead of a partial archive when compressing a world throws", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeFileSync(join(sourcePath, "Saves", "World.vcdbs"), "world", "utf8")
    writeConfig([installation("install-a", sourcePath)])
    const event = await createTrustedEvent()
    runCompression.mockRejectedValueOnce(new Error("disk full"))

    const result = await handler("worlds-backup")(event, "install-a", "World.vcdbs")

    assert.deepEqual(result, { ok: false, reason: "operation-failed" })
    const config = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    expect(config.installations[0]?.worldBackups ?? []).toEqual([])
  })

  it("refuses restore when archive validation rejects", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    const sourceWorld = join(sourcePath, "Saves", "World.vcdbs")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeFileSync(sourceWorld, "world", "utf8")
    const backupId = "backup-fail-validation"
    const backupArchive = join(backupsFolder, "Worlds", `${backupId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(backupArchive, "dummy", "utf8")
    writeConfig([installation("install-a", sourcePath, "1.22.7", [{ id: backupId, date: 1, path: backupArchive, worldName: "World.vcdbs" }])])
    const event = await createTrustedEvent()
    validateWorldBackupArchive.mockRejectedValueOnce(new Error("corrupt archive"))

    const result = await handler("worlds-restore")(event, "install-a", backupId)
    assert.deepEqual(result, { ok: false, reason: "operation-failed" })
  })

  it("refuses restore when an orphan world sidecar exists beside the backup target", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    const savesPath = join(sourcePath, "Saves")
    mkdirSync(savesPath, { recursive: true })
    writeFileSync(join(savesPath, "World.vcdbs-wal"), "pending write", "utf8")
    const backupId = "backup-orphan-sidecar"
    const backupArchive = join(backupsFolder, "Worlds", `${backupId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(backupArchive, "dummy", "utf8")
    writeConfig([installation("install-a", sourcePath, "1.22.7", [{ id: backupId, date: 1, path: backupArchive, worldName: "World.vcdbs" }])])
    const event = await createTrustedEvent()

    const result = await handler("worlds-restore")(event, "install-a", backupId)

    assert.deepEqual(result, { ok: false, reason: "world-has-sidecars" })
    expect(extractTarGz).not.toHaveBeenCalled()
  })

  it("refuses restore when extracted archive contains multiple files or an unsafe file", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    const sourceWorld = join(sourcePath, "Saves", "World.vcdbs")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeFileSync(sourceWorld, "world", "utf8")
    const backupId = "backup-multi-entry"
    const backupArchive = join(backupsFolder, "Worlds", `${backupId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(backupArchive, "dummy", "utf8")
    writeConfig([installation("install-a", sourcePath, "1.22.7", [{ id: backupId, date: 1, path: backupArchive, worldName: "World.vcdbs" }])])
    const event = await createTrustedEvent()

    // Multiple entries extracted
    extractTarGz.mockImplementationOnce(async (_archivePath, outputPath) => {
      writeFileSync(join(outputPath, "World.vcdbs"), "data", "utf8")
      writeFileSync(join(outputPath, "Extra.vcdbs"), "extra", "utf8")
    })
    const multiResult = await handler("worlds-restore")(event, "install-a", backupId)
    assert.deepEqual(multiResult, { ok: false, reason: "operation-failed" })

    // Unsafe entry name
    extractTarGz.mockImplementationOnce(async (_archivePath, outputPath) => {
      writeFileSync(join(outputPath, "unsafe.txt"), "unsafe", "utf8")
    })
    const unsafeResult = await handler("worlds-restore")(event, "install-a", backupId)
    assert.deepEqual(unsafeResult, { ok: false, reason: "operation-failed" })
  })
  const chmodIt = process.platform === "win32" ? it.skip : it
  chmodIt("returns operation-failed instead of rejecting when the Saves folder is not writable", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    const backupId = "backup-unwritable-saves"
    const backupArchive = join(backupsFolder, "Worlds", `${backupId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(backupArchive, "dummy", "utf8")
    writeConfig([installation("install-a", sourcePath, "1.22.7", [{ id: backupId, date: 1, path: backupArchive, worldName: "World.vcdbs" }])])
    const event = await createTrustedEvent()
    const savesPath = join(sourcePath, "Saves")
    chmodSync(savesPath, 0o500)

    try {
      const result = await handler("worlds-restore")(event, "install-a", backupId)
      assert.deepEqual(result, { ok: false, reason: "operation-failed" })
    } finally {
      chmodSync(savesPath, 0o700)
    }
  })

  it("refuses restore when the extracted archive contains a non-file entry", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    const backupId = "backup-subdir-entry"
    const backupArchive = join(backupsFolder, "Worlds", `${backupId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(backupArchive, "dummy", "utf8")
    writeConfig([installation("install-a", sourcePath, "1.22.7", [{ id: backupId, date: 1, path: backupArchive, worldName: "World.vcdbs" }])])
    const event = await createTrustedEvent()

    extractTarGz.mockImplementationOnce(async (_archivePath, outputPath) => {
      mkdirSync(join(outputPath, "Nested"), { recursive: true })
    })
    const result = await handler("worlds-restore")(event, "install-a", backupId)
    assert.deepEqual(result, { ok: false, reason: "operation-failed" })
    assert.equal(existsSync(join(sourcePath, "Saves", "World.vcdbs")), false)
  })

  it("fails mutating operations when path assertions reject", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    const targetPath = join(installationsRoot, "install-b")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    mkdirSync(join(targetPath, "Saves"), { recursive: true })
    writeFileSync(join(sourcePath, "Saves", "World.vcdbs"), "world", "utf8")
    writeConfig([installation("install-a", sourcePath), installation("install-b", targetPath)])
    const event = await createTrustedEvent()

    // Backup fails when assertManagedPath rejects on world.path
    assertManagedPathSpy.mockImplementation(async (value: unknown, name?: string, options?: Parameters<typeof realAssertManagedPath>[2]) => {
      if (name === "world") throw new TypeError("Unmanaged world path")
      return realAssertManagedPath(value, name, options)
    })
    const backupFail = await handler("worlds-backup")(event, "install-a", "World.vcdbs")
    assert.deepEqual(backupFail, { ok: false, reason: "operation-failed" })
    assertManagedPathSpy.mockImplementation(realAssertManagedPath)

    // Delete fails when assertManagedDeletionPath rejects on world.path
    assertManagedDeletionPathSpy.mockRejectedValueOnce(new TypeError("Protected path"))
    const deleteFail = await handler("worlds-delete")(event, "install-a", "World.vcdbs")
    assert.deepEqual(deleteFail, { ok: false, reason: "operation-failed" })

    // Transfer fails when assertManagedPath rejects on destination world
    assertManagedPathSpy.mockImplementation(async (value: unknown, name?: string, options?: Parameters<typeof realAssertManagedPath>[2]) => {
      if (name === "destination world") throw new TypeError("Unmanaged destination world")
      return realAssertManagedPath(value, name, options)
    })
    const transferFail = await handler("worlds-transfer")(event, "install-a", "World.vcdbs", "install-b", "copy")
    assert.deepEqual(transferFail, { ok: false, reason: "operation-failed" })
    assertManagedPathSpy.mockImplementation(realAssertManagedPath)

    // Restore fails when assertManagedPath rejects on the backup archive
    const restoreBackupId = "backup-managed-assert"
    const restoreBackupArchive = join(backupsFolder, "Worlds", `${restoreBackupId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(restoreBackupArchive, "dummy", "utf8")
    const restoreConfig = [
      installation("install-a", sourcePath, "1.22.7", [{ id: restoreBackupId, date: 1, path: restoreBackupArchive, worldName: "World.vcdbs" }]),
      installation("install-b", targetPath)
    ]
    writeConfig(restoreConfig)
    await (await import("@src/config/configManager")).saveConfig(JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType)
    assertManagedPathSpy.mockImplementation(async (value: unknown, name?: string, options?: Parameters<typeof realAssertManagedPath>[2]) => {
      if (name === "world backup") throw new TypeError("Unmanaged backup archive")
      return realAssertManagedPath(value, name, options)
    })
    const restoreArchiveFail = await handler("worlds-restore")(event, "install-a", restoreBackupId)
    assert.deepEqual(restoreArchiveFail, { ok: false, reason: "operation-failed" })
    expect(extractTarGz).not.toHaveBeenCalled()
    assertManagedPathSpy.mockImplementation(realAssertManagedPath)

    assertManagedPathSpy.mockImplementation(async (value: unknown, name?: string, options?: Parameters<typeof realAssertManagedPath>[2]) => {
      if (name === "restored world") throw new TypeError("Unmanaged restore target")
      return realAssertManagedPath(value, name, options)
    })
    const restoreTargetFail = await handler("worlds-restore")(event, "install-a", restoreBackupId)
    assert.deepEqual(restoreTargetFail, { ok: false, reason: "operation-failed" })
    assertManagedPathSpy.mockImplementation(realAssertManagedPath)

    // Restore fails when assertManagedPath rejects after the backup is restored
    assertManagedPathSpy.mockImplementation(async (value: unknown, name?: string, options?: Parameters<typeof realAssertManagedPath>[2]) => {
      if (name === "world" && !String(value).includes(".tar.gz")) throw new TypeError("Unmanaged transfer world")
      return realAssertManagedPath(value, name, options)
    })
    const transferWorldFail = await handler("worlds-transfer")(event, "install-a", "World.vcdbs", "install-b", "copy")
    assert.deepEqual(transferWorldFail, { ok: false, reason: "operation-failed" })
    assertManagedPathSpy.mockImplementation(realAssertManagedPath)
  })

  it("refuses every mutating worlds channel while an installation is playing", async () => {
    const installationPath = join(installationsRoot, "install-a")
    mkdirSync(join(installationPath, "Saves"), { recursive: true })
    writeFileSync(join(installationPath, "Saves", "World.vcdbs"), "world", "utf8")
    writeConfig([installation("install-a", installationPath), installation("install-b", join(installationsRoot, "install-b"))])
    const event = await createTrustedEvent()
    assert.equal(markInstallationPlaying("install-a"), true)

    try {
      const results = await Promise.all([
        handler("worlds-backup")(event, "install-a", "World.vcdbs"),
        handler("worlds-restore")(event, "install-a", "missing-backup"),
        handler("worlds-delete")(event, "install-a", "World.vcdbs"),
        handler("worlds-transfer")(event, "install-a", "World.vcdbs", "install-b", "copy")
      ])
      expect(results).toEqual([
        { ok: false, reason: "installation-playing" },
        { ok: false, reason: "installation-playing" },
        { ok: false, reason: "installation-playing" },
        { ok: false, reason: "installation-playing" }
      ])
    } finally {
      clearInstallationPlaying("install-a")
    }
  })

  it("refuses a transfer when only the target installation is playing", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    const targetPath = join(installationsRoot, "install-b")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    mkdirSync(join(targetPath, "Saves"), { recursive: true })
    writeFileSync(join(sourcePath, "Saves", "World.vcdbs"), "world", "utf8")
    writeConfig([installation("install-a", sourcePath), installation("install-b", targetPath)])
    const event = await createTrustedEvent()
    assert.equal(markInstallationPlaying("install-b"), true)

    try {
      const result = await handler("worlds-transfer")(event, "install-a", "World.vcdbs", "install-b", "copy")
      assert.deepEqual(result, { ok: false, reason: "installation-playing" })
    } finally {
      clearInstallationPlaying("install-b")
    }
  })

  it("refuses backup, restore, delete, and copy or move transfers when a world has SQLite sidecars", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    const targetPath = join(installationsRoot, "install-b")
    const savesPath = join(sourcePath, "Saves")
    const targetSavesPath = join(targetPath, "Saves")
    const archivePath = join(backupsFolder, "Worlds", "backup-sidecars.tar.gz")
    const walName = "World.vcdbs-wal"
    const shmName = "World.vcdbs-shm"
    const sidecarNames = [walName, shmName]
    mkdirSync(savesPath, { recursive: true })
    mkdirSync(targetSavesPath, { recursive: true })
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(join(savesPath, "World.vcdbs"), "world", "utf8")
    writeFileSync(join(savesPath, walName), "wal", "utf8")
    writeFileSync(join(savesPath, shmName), "shm", "utf8")
    writeFileSync(archivePath, "archive", "utf8")
    writeConfig([installation("install-a", sourcePath, "1.22.7", [{ id: "backup-sidecars", date: 1, path: archivePath, worldName: "World.vcdbs" }]), installation("install-b", targetPath)])
    await (await import("@src/config/configManager")).getConfig()
    const beforeFiles = ["World.vcdbs", ...sidecarNames].map((name) => [name, readFileSync(join(savesPath, name), "utf8")])
    const beforeConfig = readFileSync(join(userDataPath, "config.json"), "utf8")
    const event = await createTrustedEvent()

    const results = [
      await handler("worlds-backup")(event, "install-a", "World.vcdbs"),
      await handler("worlds-delete")(event, "install-a", "World.vcdbs"),
      await handler("worlds-restore")(event, "install-a", "backup-sidecars"),
      await handler("worlds-transfer")(event, "install-a", "World.vcdbs", "install-b", "copy"),
      await handler("worlds-transfer")(event, "install-a", "World.vcdbs", "install-b", "move")
    ]

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ ok: false, reason: "world-has-sidecars" })))
    expect(runCompression).not.toHaveBeenCalled()
    expect(extractTarGz).not.toHaveBeenCalled()
    expect(readFileSync(join(userDataPath, "config.json"), "utf8")).toBe(beforeConfig)
    expect(["World.vcdbs", ...sidecarNames].map((name) => [name, readFileSync(join(savesPath, name), "utf8")])).toEqual(beforeFiles)
    expect(existsSync(archivePath)).toBe(true)
    await expect((await import("node:fs/promises")).readdir(targetSavesPath)).resolves.toEqual([])
  })

  it("routes same-installation transfer refusal through the domain rule", async () => {
    const installationPath = join(installationsRoot, "install-a")
    mkdirSync(join(installationPath, "Saves"), { recursive: true })
    writeFileSync(join(installationPath, "Saves", "World.vcdbs"), "world", "utf8")
    writeConfig([installation("install-a", installationPath)])

    const result = await handler("worlds-transfer")(await createTrustedEvent(), "install-a", "World.vcdbs", "install-a", "copy")

    assert.deepEqual(result, { ok: false, reason: "invalid-request" })
  })

  it("preserves both world backup records when different installations finish concurrently", async () => {
    const firstPath = join(installationsRoot, "install-a")
    const secondPath = join(installationsRoot, "install-b")
    mkdirSync(join(firstPath, "Saves"), { recursive: true })
    mkdirSync(join(secondPath, "Saves"), { recursive: true })
    writeFileSync(join(firstPath, "Saves", "First.vcdbs"), "first", "utf8")
    writeFileSync(join(secondPath, "Saves", "Second.vcdbs"), "second", "utf8")
    writeConfig([installation("install-a", firstPath), installation("install-b", secondPath)])
    const event = await createTrustedEvent()
    compressionState.block = true

    const first = handler("worlds-backup")(event, "install-a", "First.vcdbs")
    const second = handler("worlds-backup")(event, "install-b", "Second.vcdbs")
    await waitFor(() => compressionState.calls.length === 2)
    while (compressionState.release.length) compressionState.release.shift()?.()

    const results = await Promise.all([first, second])
    expect(results.every((result) => (result as WorldBackupResult).ok)).toBe(true)
    const savedConfig = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    const savedWorldNames = savedConfig.installations
      .flatMap((candidate) => candidate.worldBackups ?? [])
      .map((backup) => backup.worldName)
      .sort()
    expect(savedWorldNames).toEqual(["First.vcdbs", "Second.vcdbs"])
  })

  it("deletes a world backup archive and removes its record from configuration", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    const backupId = "a0000000-0000-4000-8000-000000000001"
    const backupDir = join(backupsFolder, "Worlds")
    mkdirSync(backupDir, { recursive: true })
    const archivePath = join(backupDir, `${backupId}.tar.gz`)
    writeFileSync(archivePath, "backup-archive", "utf8")

    const existingBackup: WorldBackupType = {
      id: backupId,
      date: 12345,
      path: archivePath,
      worldName: "World.vcdbs"
    }
    writeConfig([installation("install-a", sourcePath, "1.22.7", [existingBackup])])
    const event = await createTrustedEvent()

    const result = await handler("worlds-delete-backup")(event, "install-a", backupId)
    assert.deepEqual(result, { ok: true })
    expect(existsSync(archivePath)).toBe(false)

    const savedConfig = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    expect(savedConfig.installations[0]?.worldBackups ?? []).toEqual([])
  })

  it("treats a missing world backup archive as deleted and drops its record", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    const backupId = "backup-missing-archive"
    const nonExistentPath = join(backupsFolder, "Worlds", `${backupId}.tar.gz`)

    const existingBackup: WorldBackupType = {
      id: backupId,
      date: 12345,
      path: nonExistentPath,
      worldName: "World.vcdbs"
    }
    writeConfig([installation("install-a", sourcePath, "1.22.7", [existingBackup])])
    const event = await createTrustedEvent()

    const result = await handler("worlds-delete-backup")(event, "install-a", backupId)
    assert.deepEqual(result, { ok: true })

    const savedConfig = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    expect(savedConfig.installations[0]?.worldBackups ?? []).toEqual([])
  })

  it("returns archive-not-found when deleting an unknown world backup id", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeConfig([installation("install-a", sourcePath)])
    const event = await createTrustedEvent()

    const result = await handler("worlds-delete-backup")(event, "install-a", "no-such-backup")
    assert.deepEqual(result, { ok: false, reason: "archive-not-found" })
  })

  it("prunes oldest world backups for that world when backupsLimit is reached and deletes their archives", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeFileSync(join(sourcePath, "Saves", "World.vcdbs"), "live-world", "utf8")

    const backupDir = join(backupsFolder, "Worlds")
    mkdirSync(backupDir, { recursive: true })

    const id1 = "10000000-0000-4000-8000-000000000001"
    const idOther = "20000000-0000-4000-8000-000000000002"
    const id2 = "30000000-0000-4000-8000-000000000003"
    const archive1 = join(backupDir, `${id1}.tar.gz`)
    const archive2 = join(backupDir, `${id2}.tar.gz`)
    const archiveOther = join(backupDir, `${idOther}.tar.gz`)
    writeFileSync(archive1, "archive-1", "utf8")
    writeFileSync(archive2, "archive-2", "utf8")
    writeFileSync(archiveOther, "archive-other", "utf8")

    const existingBackups: WorldBackupType[] = [
      { id: id1, date: 200, path: archive1, worldName: "World.vcdbs" },
      { id: idOther, date: 150, path: archiveOther, worldName: "Other.vcdbs" },
      { id: id2, date: 100, path: archive2, worldName: "World.vcdbs" }
    ]

    const inst = installation("install-a", sourcePath, "1.22.7", existingBackups)
    inst.backupsLimit = 2
    writeConfig([inst])

    const event = await createTrustedEvent()
    const result = (await handler("worlds-backup")(event, "install-a", "World.vcdbs")) as WorldBackupResult
    assert.equal(result.ok, true)
    if (!result.ok) return

    expect(result.deletedBackupIds).toEqual([id2])
    expect(existsSync(archive2)).toBe(false)
    expect(existsSync(archive1)).toBe(true)
    expect(existsSync(archiveOther)).toBe(true)

    const savedConfig = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    const savedBackups = savedConfig.installations[0]?.worldBackups ?? []
    expect(savedBackups).toHaveLength(3)
    expect(savedBackups.map((b) => b.id)).toEqual([result.backup.id, id1, idOther])
  })

  it("cleans up dead records whose archive was missing on disk when creating a new world backup", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeFileSync(join(sourcePath, "Saves", "World.vcdbs"), "live-world", "utf8")

    const deadId = "40000000-0000-4000-8000-000000000004"
    const existingBackups: WorldBackupType[] = [{ id: deadId, date: 100, path: join(backupsFolder, "Worlds", "missing.tar.gz"), worldName: "World.vcdbs" }]

    const inst = installation("install-a", sourcePath, "1.22.7", existingBackups)
    inst.backupsLimit = 3
    writeConfig([inst])

    const event = await createTrustedEvent()
    const result = (await handler("worlds-backup")(event, "install-a", "World.vcdbs")) as WorldBackupResult
    assert.equal(result.ok, true)
    if (!result.ok) return

    expect(result.deletedBackupIds).toEqual([deadId])

    const savedConfig = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    const savedBackups = savedConfig.installations[0]?.worldBackups ?? []
    expect(savedBackups).toHaveLength(1)
    expect(savedBackups[0]?.id).toBe(result.backup.id)
  })

  it("refuses to delete a world backup when the installation is playing", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    const backupId = "50000000-0000-4000-8000-000000000005"
    const archivePath = join(backupsFolder, "Worlds", `${backupId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(archivePath, "data", "utf8")
    writeConfig([installation("install-a", sourcePath, "1.22.7", [{ id: backupId, date: 1, path: archivePath, worldName: "World.vcdbs" }])])
    const event = await createTrustedEvent()

    markInstallationPlaying("install-a")
    try {
      const result = await handler("worlds-delete-backup")(event, "install-a", backupId)
      assert.deepEqual(result, { ok: false, reason: "installation-playing" })
      expect(existsSync(archivePath)).toBe(true)
    } finally {
      clearInstallationPlaying("install-a")
    }
  })

  it("refuses to delete a world backup when backupId is not a string", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeConfig([installation("install-a", sourcePath)])
    const event = await createTrustedEvent()

    const result = await handler("worlds-delete-backup")(event, "install-a", 12345)
    assert.deepEqual(result, { ok: false, reason: "invalid-request" })
  })

  it("refuses to delete a world backup when another operation holds the lease", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    const backupId = "60000000-0000-4000-8000-000000000006"
    const archivePath = join(backupsFolder, "Worlds", `${backupId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(archivePath, "data", "utf8")
    writeConfig([installation("install-a", sourcePath, "1.22.7", [{ id: backupId, date: 1, path: archivePath, worldName: "World.vcdbs" }])])
    const event = await createTrustedEvent()

    const lease = tryAcquireInstallationOperation(["install-a"])
    assert.equal(lease.ok, true)
    if (!lease.ok) return
    try {
      const result = await handler("worlds-delete-backup")(event, "install-a", backupId)
      assert.deepEqual(result, { ok: false, reason: "world-busy" })
      expect(existsSync(archivePath)).toBe(true)
    } finally {
      lease.release()
    }
  })

  it("refuses to delete a world backup whose path does not match the Worlds folder and backup id convention", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    const worldFile = join(sourcePath, "Saves", "World.vcdbs")
    writeFileSync(worldFile, "live-world", "utf8")

    const outsideFolder = join(temporaryRoot, "outside-folder")
    mkdirSync(outsideFolder, { recursive: true })
    mkdirSync(backupsFolder, { recursive: true })
    const outsideFile = join(outsideFolder, "important.txt")
    writeFileSync(outsideFile, "important", "utf8")

    const idValid = "80000000-0000-4000-8000-000000000008"
    const otherId = "90000000-0000-4000-8000-000000000009"
    const mismatchArchive = join(backupsFolder, "Worlds", `${otherId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(mismatchArchive, "mismatch", "utf8")

    const installationWorldsFolder = join(backupsFolder, "Installations", "Worlds")
    mkdirSync(installationWorldsFolder, { recursive: true })
    const instArchive = join(installationWorldsFolder, `${idValid}.tar.gz`)
    writeFileSync(instArchive, "inst-archive", "utf8")

    const existingBackups: WorldBackupType[] = [
      { id: "crafted-1", date: 1, path: outsideFolder, worldName: "World.vcdbs" },
      { id: "crafted-2", date: 2, path: worldFile, worldName: "World.vcdbs" },
      { id: "crafted-3", date: 3, path: backupsFolder, worldName: "World.vcdbs" },
      { id: idValid, date: 4, path: mismatchArchive, worldName: "World.vcdbs" },
      { id: "inst-worlds-id", date: 5, path: instArchive, worldName: "World.vcdbs" }
    ]
    writeConfig([installation("install-a", sourcePath, "1.22.7", existingBackups)])
    const event = await createTrustedEvent()

    const result1 = await handler("worlds-delete-backup")(event, "install-a", "crafted-1")
    assert.deepEqual(result1, { ok: false, reason: "operation-failed" })
    expect(existsSync(outsideFile)).toBe(true)

    const result2 = await handler("worlds-delete-backup")(event, "install-a", "crafted-2")
    assert.deepEqual(result2, { ok: false, reason: "operation-failed" })
    expect(existsSync(worldFile)).toBe(true)

    const result3 = await handler("worlds-delete-backup")(event, "install-a", "crafted-3")
    assert.deepEqual(result3, { ok: false, reason: "operation-failed" })
    expect(existsSync(backupsFolder)).toBe(true)

    const resultMismatch = await handler("worlds-delete-backup")(event, "install-a", idValid)
    assert.deepEqual(resultMismatch, { ok: false, reason: "operation-failed" })
    expect(existsSync(mismatchArchive)).toBe(true)

    const resultInst = await handler("worlds-delete-backup")(event, "install-a", "inst-worlds-id")
    assert.deepEqual(resultInst, { ok: false, reason: "operation-failed" })
    expect(existsSync(instArchive)).toBe(true)
  })

  it("refuses to delete another world's archive when pruning older backups (#620)", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeFileSync(join(sourcePath, "Saves", "World.vcdbs"), "live-world", "utf8")

    const backupDir = join(backupsFolder, "Worlds")
    mkdirSync(backupDir, { recursive: true })

    const otherWorldArchive = join(backupDir, "other-world-archive.tar.gz")
    writeFileSync(otherWorldArchive, "protected-other-archive", "utf8")

    const idPruned = "71111111-0000-4000-8000-000000000001"
    const existingBackups: WorldBackupType[] = [{ id: idPruned, date: 100, path: otherWorldArchive, worldName: "World.vcdbs" }]

    const inst = installation("install-a", sourcePath, "1.22.7", existingBackups)
    inst.backupsLimit = 1
    writeConfig([inst])

    const event = await createTrustedEvent()
    const result = (await handler("worlds-backup")(event, "install-a", "World.vcdbs")) as WorldBackupResult
    assert.equal(result.ok, true)
    if (!result.ok) return

    expect(existsSync(otherWorldArchive)).toBe(true)
    expect(result.deletedBackupIds).toEqual([])
  })

  it("refuses to make a world backup when backupsLimit is 0", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeFileSync(join(sourcePath, "Saves", "World.vcdbs"), "live-world", "utf8")

    const inst = installation("install-a", sourcePath)
    inst.backupsLimit = 0
    writeConfig([inst])

    const event = await createTrustedEvent()
    const result = (await handler("worlds-backup")(event, "install-a", "World.vcdbs")) as WorldBackupResult
    assert.deepEqual(result, { ok: false, reason: "backups-disabled" })
  })

  it("leaves unreachable world backup records alone during pruning", async () => {
    const sourcePath = join(installationsRoot, "install-a")
    mkdirSync(join(sourcePath, "Saves"), { recursive: true })
    writeFileSync(join(sourcePath, "Saves", "World.vcdbs"), "live-world", "utf8")

    const backupDir = join(backupsFolder, "Worlds")
    mkdirSync(backupDir, { recursive: true })
    const id1 = "10000000-0000-4000-8000-000000000001"
    const archive1 = join(backupDir, `${id1}.tar.gz`)
    writeFileSync(archive1, "archive-1", "utf8")

    const unreachablePath = join(temporaryRoot, "missing-drive", "Worlds", "wb-unreachable.tar.gz")

    const existingBackups: WorldBackupType[] = [
      { id: id1, date: 200, path: archive1, worldName: "World.vcdbs" },
      { id: "70000000-0000-4000-8000-000000000007", date: 100, path: unreachablePath, worldName: "World.vcdbs" }
    ]

    const inst = installation("install-a", sourcePath, "1.22.7", existingBackups)
    inst.backupsLimit = 3
    writeConfig([inst])

    const event = await createTrustedEvent()
    const result = (await handler("worlds-backup")(event, "install-a", "World.vcdbs")) as WorldBackupResult
    assert.equal(result.ok, true)
    if (!result.ok) return

    expect(result.deletedBackupIds).toEqual([])
    const savedConfig = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    const savedBackups = savedConfig.installations[0]?.worldBackups ?? []
    expect(savedBackups.map((b) => b.id)).toContain("70000000-0000-4000-8000-000000000007")
  })
})
