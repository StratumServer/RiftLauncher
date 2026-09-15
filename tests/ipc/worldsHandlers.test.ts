import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

vi.mock("@src/ipc/workers/compression", () => ({ runCompression }))
vi.mock("@src/ipc/workers/extraction", () => ({ extractTarGz }))
vi.mock("@src/ipc/archiveValidation", () => ({ validateWorldBackupArchive: vi.fn(async () => undefined) }))

const CURRENT_SCHEMA = 6
let temporaryRoot: string
let userDataPath: string
let installationsRoot: string
let backupsFolder: string
let markInstallationPlaying: typeof import("@src/ipc/installationActivity").markInstallationPlaying
let clearInstallationPlaying: typeof import("@src/ipc/installationActivity").clearInstallationPlaying

type WorldsHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

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

  vi.resetModules()
  ;({ markInstallationPlaying, clearInstallationPlaying } = await import("@src/ipc/installationActivity"))
  await import("@src/ipc/handlers/worldsHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("worlds IPC handlers", () => {
  it("registers every worlds channel and rejects an untrusted sender", async () => {
    const event = createUntrustedEvent()
    const channels = ["worlds-list", "worlds-backup", "worlds-restore", "worlds-delete", "worlds-transfer"]

    for (const channel of channels) {
      await assert.rejects(() => handler(channel)(event, "install-a", "World.vcdbs", "install-b", "copy"), /Unauthorized IPC sender/)
    }
  })

  it("lists only safe world files from the configured Saves folder", async () => {
    const installationPath = join(installationsRoot, "install-a")
    const savesPath = join(installationPath, "Saves")
    mkdirSync(savesPath, { recursive: true })
    writeFileSync(join(savesPath, "World.vcdbs"), "world", "utf8")
    writeFileSync(join(savesPath, "notes.txt"), "not a world", "utf8")
    writeFileSync(join(savesPath, "unsafe.vcdbs "), "unsafe", "utf8")
    writeConfig([installation("install-a", installationPath)])

    const result = await handler("worlds-list")(await createTrustedEvent(), "install-a")

    assert.deepEqual(result, {
      ok: true,
      worlds: [
        {
          name: "World.vcdbs",
          size: 5,
          lastModified: (result as WorldListResult & { ok: true }).worlds[0]?.lastModified,
          isDefault: false,
          backupCount: 0
        }
      ]
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
    const configAfterBackup = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    assert.equal(configAfterBackup.installations[0]?.worldBackups?.[0]?.id, backupResult.backup.id)

    const restoreResult = await handler("worlds-restore")(event, "install-a", backupResult.backup.id)
    assert.deepEqual(restoreResult, { ok: true })
    assert.equal(readFileSync(sourceWorld, "utf8"), "restored")

    const transferResult = await handler("worlds-transfer")(event, "install-a", "World.vcdbs", "install-b", "copy")
    assert.deepEqual(transferResult, { ok: true, targetWorldName: "World.vcdbs", warning: "different-version" })
    expect(existsSync(join(targetPath, "Saves", "World.vcdbs"))).toBe(true)

    const deleteResult = await handler("worlds-delete")(event, "install-a", "World.vcdbs")
    assert.deepEqual(deleteResult, { ok: true })
    expect(existsSync(sourceWorld)).toBe(false)
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
    compressionState.release.shift()?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    compressionState.release.shift()?.()

    const results = await Promise.all([first, second])
    expect(results.every((result) => (result as WorldBackupResult).ok)).toBe(true)
    const savedConfig = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    const savedWorldNames = savedConfig.installations
      .flatMap((candidate) => candidate.worldBackups ?? [])
      .map((backup) => backup.worldName)
      .sort()
    expect(savedWorldNames).toEqual(["First.vcdbs", "Second.vcdbs"])
  })
})
