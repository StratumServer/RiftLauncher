import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

const writes = vi.hoisted(() => ({ failNext: 0, calls: 0, failCall: 0, gate: null as Promise<void> | null }))

// The real atomic write, except that the next `failNext` calls fail the way a full disk or a refused rename does,
// the call numbered `failCall` fails, and the first call waits for `gate` before it writes.
vi.mock("@src/ipc/atomicJsonFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/ipc/atomicJsonFile")>()
  return {
    ...actual,
    writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>): Promise<void> => {
      writes.calls += 1
      const call = writes.calls
      if (call === 1 && writes.gate) await writes.gate
      if (call === writes.failCall) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" })
      if (writes.failNext > 0) {
        writes.failNext -= 1
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
      }
      return actual.writeJsonAtomic(...args)
    }
  }
})

vi.mock("@src/ipc/workers/compression", () => ({
  runCompression: async ({ outputPath, outputFileName }: { outputPath: string; outputFileName: string }): Promise<void> => {
    mkdirSync(outputPath, { recursive: true })
    writeFileSync(join(outputPath, outputFileName), "archive", "utf8")
  }
}))

const CURRENT_SCHEMA = 6
let temporaryRoot: string
let userDataPath: string
let installationsRoot: string
let backupsFolder: string
let event: IpcMainInvokeEvent
let configManager: typeof import("@src/config/configManager")

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

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

function handler(channel: string): Handler {
  return getIpcHandler<Handler>(channel)
}

function archives(): string[] {
  const folder = join(backupsFolder, "Worlds")
  return existsSync(folder) ? readdirSync(folder) : []
}

function diskBackups(): WorldBackupType[] {
  const saved = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
  return saved.installations[0]?.worldBackups ?? []
}

async function cachedBackups(): Promise<WorldBackupType[]> {
  return (await configManager.getConfig()).installations[0]?.worldBackups ?? []
}

/** What a window move does: main reads its copy of the config and saves it back. */
async function moveWindow(): Promise<void> {
  const config = await configManager.getConfig()
  config.window = { ...config.window, x: 40, y: 60 }
  await configManager.saveConfig(config)
  await configManager.flushConfigWrites()
}

function makeWorld(): void {
  const saves = join(installationsRoot, "install-a", "Saves")
  mkdirSync(saves, { recursive: true })
  writeFileSync(join(saves, "World.vcdbs"), "the player's world", "utf8")
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "world-record-failure-"))
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
  writes.failNext = 0
  writes.calls = 0
  writes.failCall = 0
  writes.gate = null

  vi.resetModules()
  configManager = await import("@src/config/configManager")
  await import("@src/ipc/handlers/worldsHandlers")
  await import("@src/ipc/handlers/configHandlers")
  event = await createTrustedEvent()
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("a world backup whose config write fails", () => {
  it("answers operation-failed, removes the archive and leaves no record in memory", async () => {
    makeWorld()
    writeConfig([installation("install-a", join(installationsRoot, "install-a"))])
    await configManager.getConfig()

    writes.failNext = 1
    const result = await handler("worlds-backup")(event, "install-a", "World.vcdbs")

    expect(result).toEqual({ ok: false, reason: "operation-failed" })
    expect(archives()).toEqual([])
    expect(await cachedBackups()).toEqual([])
  })

  it("is not written by the window save that follows", async () => {
    makeWorld()
    writeConfig([installation("install-a", join(installationsRoot, "install-a"))])
    await configManager.getConfig()

    writes.failNext = 1
    await handler("worlds-backup")(event, "install-a", "World.vcdbs")
    await moveWindow()

    expect(diskBackups()).toEqual([])
    expect((JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType).window.x).toBe(40)
  })

  it("is not written by the renderer save that follows, so a restore is never offered a missing archive", async () => {
    makeWorld()
    writeConfig([installation("install-a", join(installationsRoot, "install-a"))])
    await configManager.getConfig()

    writes.failNext = 1
    await handler("worlds-backup")(event, "install-a", "World.vcdbs")
    const rendererView = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    await handler("save-config")(event, rendererView)
    await configManager.flushConfigWrites()

    expect(diskBackups()).toEqual([])
    expect(await cachedBackups()).toEqual([])
  })

  it("keeps the backups that were already recorded", async () => {
    makeWorld()
    const older: WorldBackupType = {
      id: "70000000-0000-4000-8000-000000000007",
      date: 100,
      path: join(backupsFolder, "Worlds", "70000000-0000-4000-8000-000000000007.tar.gz"),
      worldName: "World.vcdbs"
    }
    writeConfig([installation("install-a", join(installationsRoot, "install-a"), [older])])
    await configManager.getConfig()

    writes.failNext = 1
    await handler("worlds-backup")(event, "install-a", "World.vcdbs")
    await moveWindow()

    expect((await cachedBackups()).map((b) => b.id)).toEqual([older.id])
    expect(diskBackups().map((b) => b.id)).toEqual([older.id])
  })

  it("keeps a change made in memory by another save in the meantime", async () => {
    makeWorld()
    writeConfig([installation("install-a", join(installationsRoot, "install-a"))])
    await configManager.getConfig()

    // The backup's write and a window move land in the same coalesced write, which fails for both.
    // (The first write attempt fails once; the retry of the rolled-back config then succeeds.)
    writes.failNext = 1
    const backup = handler("worlds-backup")(event, "install-a", "World.vcdbs")
    await vi.waitFor(async () => expect((await cachedBackups()).length).toBe(1))
    const config = await configManager.getConfig()
    config.window = { ...config.window, x: 40, y: 60 }
    const windowSave = configManager.saveConfig(config)
    expect(await backup).toEqual({ ok: false, reason: "operation-failed" })
    await windowSave

    expect(await cachedBackups()).toEqual([])
    expect((await configManager.getConfig()).window.x).toBe(40)
    await moveWindow()
    expect(diskBackups()).toEqual([])
  })

  it("does not leave the record on disk when the write that carried it succeeds and the one coalesced behind it fails", async () => {
    makeWorld()
    writeConfig([installation("install-a", join(installationsRoot, "install-a"))])
    await configManager.getConfig()

    // The first write (the backup's config) is held in flight; a window save arrives meanwhile and
    // becomes the next pending config; the first write lands, the second is refused (EPERM).
    await configManager.flushConfigWrites()
    writes.calls = 0
    let release = (): void => undefined
    writes.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    writes.failCall = 2
    const backup = handler("worlds-backup")(event, "install-a", "World.vcdbs")
    await vi.waitFor(() => expect(writes.calls).toBe(1))
    const config = await configManager.getConfig()
    config.window = { ...config.window, x: 40, y: 60 }
    const windowSave = configManager.saveConfig(config)
    release()

    expect(await backup).toEqual({ ok: false, reason: "operation-failed" })
    expect(await windowSave).toBe(false)
    await configManager.flushConfigWrites()

    // No later save: this is what the next start reads if the player quits right after the failure.
    expect(archives()).toEqual([])
    expect(await cachedBackups()).toEqual([])
    expect(diskBackups()).toEqual([])
  })

  it("still keeps the other changes of a read-only session in memory", async () => {
    makeWorld()
    // config.json cannot be read as a file: the session runs read-only and never writes it.
    mkdirSync(join(userDataPath, "config.json"))
    await configManager.getConfig()
    expect(configManager.isConfigWriteSuppressed()).toBe(true)
    const config = await configManager.getConfig()
    config.installations = [installation("install-a", join(installationsRoot, "install-a"))]
    config.window = { ...config.window, x: 40, y: 60 }
    config.backupsFolder = backupsFolder
    expect(await configManager.saveConfig(config)).toBe(false)

    const result = await handler("worlds-backup")(event, "install-a", "World.vcdbs")

    expect(result).toEqual({ ok: false, reason: "operation-failed" })
    expect(archives()).toEqual([])
    const afterwards = await configManager.getConfig()
    expect(afterwards.installations.map((i) => i.id)).toEqual(["install-a"])
    expect(afterwards.window.x).toBe(40)
    expect(afterwards.installations[0]?.worldBackups ?? []).toEqual([])
  })

  it("still records a backup when the write succeeds", async () => {
    makeWorld()
    writeConfig([installation("install-a", join(installationsRoot, "install-a"))])
    await configManager.getConfig()

    const result = (await handler("worlds-backup")(event, "install-a", "World.vcdbs")) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(archives()).toHaveLength(1)
    expect(await cachedBackups()).toHaveLength(1)
    await configManager.flushConfigWrites()
    expect(diskBackups()).toHaveLength(1)
  })
})

describe("deleting a recorded world backup whose config write fails", () => {
  const recordedId = "70000000-0000-4000-8000-000000000007"

  function recordedBackup(): WorldBackupType {
    const path = join(backupsFolder, "Worlds", `${recordedId}.tar.gz`)
    mkdirSync(join(backupsFolder, "Worlds"), { recursive: true })
    writeFileSync(path, "archive", "utf8")
    return { id: recordedId, date: 100, path, worldName: "World.vcdbs" }
  }

  it("answers ok once the archive is gone, and the renderer save that follows clears the record on disk", async () => {
    const recorded = recordedBackup()
    writeConfig([installation("install-a", join(installationsRoot, "install-a"), [recorded])])
    await configManager.getConfig()

    writes.failNext = 1
    const result = await handler("worlds-delete-backup")(event, "install-a", recordedId)

    expect(result).toEqual({ ok: true })
    expect(archives()).toEqual([])
    expect(await cachedBackups()).toEqual([])
    // The refused write left the record on disk; the save the renderer makes after the ok writes main's copy.
    const rendererView = JSON.parse(readFileSync(join(userDataPath, "config.json"), "utf8")) as ConfigType
    rendererView.installations[0]!.worldBackups = []
    await handler("save-config")(event, rendererView)
    await configManager.flushConfigWrites()
    expect(diskBackups()).toEqual([])
  })

  it("still answers a failure, and keeps the record, when the archive cannot be removed", async () => {
    const recorded = recordedBackup()
    rmSync(recorded.path)
    mkdirSync(recorded.path)
    writeConfig([installation("install-a", join(installationsRoot, "install-a"), [recorded])])
    await configManager.getConfig()

    const result = await handler("worlds-delete-backup")(event, "install-a", recordedId)

    expect(result).toEqual({ ok: false, reason: "operation-failed" })
    expect((await cachedBackups()).map((b) => b.id)).toEqual([recordedId])
  })
})
