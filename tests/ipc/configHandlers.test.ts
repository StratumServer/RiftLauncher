import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * Branch coverage for src/ipc/handlers/configHandlers.ts (GET_CONFIG,
 * SAVE_CONFIG), previously entirely unimported by a test (0% branch
 * coverage): both channels call `ipcMain.handle` at module load, which needs
 * a running Electron main process.
 *
 * Everything downstream stays real on purpose: configManager.ts and
 * pathPolicy.ts are not mocked, only `electron` is (via ./helpers/electronMock,
 * extended for this campaign with ipcMain capture, a trusted-event builder,
 * and per-name app.getPath). "GET_CONFIG unreadable file -> defaults" and
 * "SAVE_CONFIG unauthorized path" only mean what production means by them if
 * the config pipeline they exercise is the genuine one.
 *
 * configManager.ts keeps process-wide module state (configPath, configReady,
 * configCache), so each test gets its own fresh copy: `vi.resetModules()` in
 * beforeEach, then a fresh temp userData folder and a fresh dynamic import of
 * configHandlers (which pulls in a fresh configManager, pathPolicy and
 * ipcSecurity together).
 */

type GetConfigHandler = (event: IpcMainInvokeEvent) => Promise<ConfigType>
type SaveConfigHandler = (event: IpcMainInvokeEvent, config: ConfigType) => Promise<SaveConfigResult>
type GetConfigRecoveryNoticeHandler = (event: IpcMainInvokeEvent) => Promise<ConfigRecoveryNotice | null>

let temporaryRoot: string
let userDataFolder: string
let appDataFolder: string

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "config-handlers-"))
  userDataFolder = join(temporaryRoot, "userData")
  appDataFolder = join(temporaryRoot, "appData")
  mkdirSync(userDataFolder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", appDataFolder)
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  vi.resetModules()
  await import("@src/ipc/handlers/configHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function getConfigHandler(): GetConfigHandler {
  return getIpcHandler<GetConfigHandler>(IPC_CHANNELS.CONFIG_MANAGER.GET_CONFIG)
}

function saveConfigHandler(): SaveConfigHandler {
  return getIpcHandler<SaveConfigHandler>(IPC_CHANNELS.CONFIG_MANAGER.SAVE_CONFIG)
}

function getConfigRecoveryNoticeHandler(): GetConfigRecoveryNoticeHandler {
  return getIpcHandler<GetConfigRecoveryNoticeHandler>(IPC_CHANNELS.CONFIG_MANAGER.GET_CONFIG_RECOVERY_NOTICE)
}

function minimalConfig(overrides: Partial<ConfigType> = {}): ConfigType {
  return {
    schemaVersion: 1,
    lastUsedInstallation: null,
    defaultInstallationsFolder: join(appDataFolder, "RiftLauncherInstallations"),
    defaultVersionsFolder: join(appDataFolder, "RiftLauncherGameVersions"),
    backupsFolder: join(appDataFolder, "RiftLauncherBackups"),
    window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
    accounts: [],
    activeAccountId: null,
    installations: [],
    gameVersions: [],
    favMods: [],
    customIcons: [],
    ...overrides
  } as unknown as ConfigType
}

describe("GET_CONFIG", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => getConfigHandler()(createUntrustedEvent()), /Unauthorized IPC sender/)
  })

  it("returns the default config when no config file exists yet", async () => {
    const event = await createTrustedEvent()
    const config = await getConfigHandler()(event)
    assert.equal(config.schemaVersion >= 1, true)
    assert.deepEqual(config.installations, [])
  })

  it("falls back to defaults when the config file on disk is unreadable JSON", async () => {
    // ensureConfig() only writes a default file when none exists; a file
    // that exists but is not valid JSON reaches getConfig()'s own catch.
    writeFileSync(join(userDataFolder, "config.json"), "{ not valid json at all", "utf-8")

    const event = await createTrustedEvent()
    const config = await getConfigHandler()(event)
    assert.deepEqual(config.installations, [])
    assert.equal(config.defaultInstallationsFolder, join(appDataFolder, "RiftLauncherInstallations"))
  })
})

describe("GET_CONFIG_RECOVERY_NOTICE", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => getConfigRecoveryNoticeHandler()(createUntrustedEvent()), /Unauthorized IPC sender/)
  })

  it("returns null when config.json is fine, and nothing has ever been recovered", async () => {
    const event = await createTrustedEvent()
    const notice = await getConfigRecoveryNoticeHandler()(event)
    assert.equal(notice, null)
  })

  /**
   * Point 3 of the #554 review: this handler used to read the pending notice synchronously, with
   * no guarantee getConfig()'s first real read (where recovery actually happens) had even started.
   * NotificationsProvider asks for the notice from its own mount effect, independent of
   * ConfigProvider's, so nothing guarantees GET_CONFIG runs first. Calling this handler with no
   * GET_CONFIG call before it, straight after startup, reproduces that race: the notice must still
   * come back correctly rather than the null an unlucky ordering used to hand back.
   */
  it("awaits the first config load before answering, even if GET_CONFIG was never called first", async () => {
    writeFileSync(join(userDataFolder, "config.json"), "{ not valid json at all", "utf-8")

    const event = await createTrustedEvent()
    const notice = await getConfigRecoveryNoticeHandler()(event)

    assert.ok(notice)
    assert.equal(notice.kind, "unreadable")
  })
})

describe("SAVE_CONFIG", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => saveConfigHandler()(createUntrustedEvent(), minimalConfig()), /Unauthorized IPC sender/)
  })

  it("refuses a payload that is not an object with invalid-payload", async () => {
    const event = await createTrustedEvent()
    const result = await saveConfigHandler()(event, null as unknown as ConfigType)
    assert.deepEqual(result, { ok: false, reason: "invalid-payload" })
  })

  it("refuses a config pointing an installation outside every authorized folder with unauthorized-path", async () => {
    const event = await createTrustedEvent()
    const outsideFolder = join(temporaryRoot, "nobody-picked-this")
    const config = minimalConfig({
      installations: [
        {
          id: "a",
          name: "A",
          icon: "",
          path: outsideFolder,
          version: "",
          startParams: "",
          backupsLimit: 3,
          backupsAuto: false,
          compressionLevel: 4,
          backups: [],
          lastTimePlayed: -1,
          totalTimePlayed: 0,
          mesaGlThread: false,
          envVars: ""
        }
      ] as unknown as ConfigType["installations"]
    })

    const result = await saveConfigHandler()(event, config)
    assert.deepEqual(result, { ok: false, reason: "unauthorized-path", refusedPaths: [outsideFolder] })
  })

  describe("a folder picked for a VS Version and added after its approval ran out (#731)", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    async function pickThenSave(minutesLater: number, gameFolder: string): Promise<{ saved: SaveConfigResult; start: ConfigType }> {
      const event = await createTrustedEvent()
      const { registerUserSelectedPaths } = await import("@src/ipc/pathPolicy")
      const start = await getConfigHandler()(event)

      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date("2026-10-16T10:00:00Z"))
      registerUserSelectedPaths([gameFolder])
      vi.setSystemTime(new Date(Date.parse("2026-10-16T10:00:00Z") + minutesLater * 60_000))
      const withVersion: ConfigType = { ...start, gameVersions: [{ id: "v1", version: "1.21.5", label: "1.21.5", path: gameFolder, linked: true }] }
      const saved = await saveConfigHandler()(event, withVersion)
      vi.useRealTimers()
      return { saved, start }
    }

    it("names the refused folder, and a save without that row goes through and is kept", async () => {
      const gameFolder = join(temporaryRoot, "Games", "Vintagestory")
      mkdirSync(gameFolder, { recursive: true })
      const event = await createTrustedEvent()

      const { saved, start } = await pickThenSave(11, gameFolder)
      assert.deepEqual(saved, { ok: false, reason: "unauthorized-path", refusedPaths: [gameFolder] })

      // What the renderer sends once it has dropped the row: the rest of the state, a favourite included.
      assert.deepEqual(await saveConfigHandler()(event, { ...start, favMods: [42] }), { ok: true })
      assert.deepEqual((await getConfigHandler()(event)).favMods, [42])
      assert.deepEqual(JSON.parse(readFileSync(join(userDataFolder, "config.json"), "utf-8")).favMods, [42])
    })

    it("names only the folders that were refused", async () => {
      const gameFolder = join(temporaryRoot, "Games", "Vintagestory")
      const insideVersionsFolder = join(appDataFolder, "RiftLauncherGameVersions", "1.21.0")
      mkdirSync(gameFolder, { recursive: true })
      const event = await createTrustedEvent()
      const start = await getConfigHandler()(event)

      const saved = await saveConfigHandler()(event, {
        ...start,
        gameVersions: [
          { id: "v1", version: "1.21.5", label: "1.21.5", path: gameFolder, linked: true },
          { id: "v2", version: "1.21.0", label: "1.21.0", path: insideVersionsFolder }
        ]
      })
      assert.deepEqual(saved, { ok: false, reason: "unauthorized-path", refusedPaths: [gameFolder] })
    })

    it("still saves the row when it is added within the ten minutes", async () => {
      const gameFolder = join(temporaryRoot, "Games", "Vintagestory")
      mkdirSync(gameFolder, { recursive: true })

      const { saved } = await pickThenSave(9, gameFolder)
      assert.deepEqual(saved, { ok: true })
    })
  })

  it("saves an authorized config and reports ok: true", async () => {
    const event = await createTrustedEvent()
    const result = await saveConfigHandler()(event, minimalConfig())
    assert.deepEqual(result, { ok: true })

    // Round-trips through the real getConfig(), proving the write landed.
    const reread = await getConfigHandler()(event)
    assert.equal(reread.defaultInstallationsFolder, join(appDataFolder, "RiftLauncherInstallations"))
  })

  it("reconciles worldBackups from current config when the renderer saves an installation", async () => {
    const event = await createTrustedEvent()
    const validPath = join(appDataFolder, "RiftLauncherInstallations", "test-install")
    mkdirSync(validPath, { recursive: true })

    const existingBackup: WorldBackupType = {
      id: "backup-1",
      worldName: "MyWorld.vcdbs",
      path: join(validPath, "backup-1.tar.gz"),
      date: 123456789
    }

    const initialConfig = minimalConfig({
      installations: [
        {
          id: "inst-1",
          name: "Inst 1",
          icon: "",
          path: validPath,
          version: "1.20.0",
          startParams: "",
          backupsLimit: 3,
          backupsAuto: false,
          compressionLevel: 4,
          backups: [],
          worldBackups: [existingBackup],
          lastTimePlayed: -1,
          totalTimePlayed: 0,
          mesaGlThread: false,
          envVars: ""
        }
      ] as unknown as ConfigType["installations"]
    })
    await saveConfigHandler()(event, initialConfig)

    // Renderer dispatches SAVE_CONFIG with empty worldBackups array
    const rendererConfig = minimalConfig({
      installations: [
        {
          id: "inst-1",
          name: "Inst 1 Renamed",
          icon: "",
          path: validPath,
          version: "1.20.0",
          startParams: "",
          backupsLimit: 3,
          backupsAuto: false,
          compressionLevel: 4,
          backups: [],
          worldBackups: [],
          lastTimePlayed: -1,
          totalTimePlayed: 0,
          mesaGlThread: false,
          envVars: ""
        }
      ] as unknown as ConfigType["installations"]
    })

    const result = await saveConfigHandler()(event, rendererConfig)
    assert.deepEqual(result, { ok: true })

    const reread = await getConfigHandler()(event)
    const install = reread.installations.find((i) => i.id === "inst-1")
    assert.ok(install)
    assert.deepEqual(install.worldBackups, [existingBackup])
  })

  // chmod 0o500 does not stop a write on Windows: NTFS enforces read-only
  // through the file attribute, not POSIX write bits on the containing folder.
  it.skipIf(process.platform === "win32")("reports write-failed when the config file cannot be written", async () => {
    const event = await createTrustedEvent()

    // Make the userData folder itself read-only so the temp-file write inside
    // saveConfig()'s writeConfig() fails; configManager.ts catches that and
    // resolves `false`, which saveOutcomeToResult maps to write-failed.
    chmodSync(userDataFolder, 0o500)

    try {
      const result = await saveConfigHandler()(event, minimalConfig())
      assert.deepEqual(result, { ok: false, reason: "write-failed" })
    } finally {
      chmodSync(userDataFolder, 0o700)
    }
  })

  /**
   * Point 1 of the #554 review: every writer, including a plain settings save from the renderer,
   * funnels through saveConfig(), which now refuses to write once the session has been marked
   * read-only. This is SAVE_CONFIG's own reason for that refusal, distinct from write-failed:
   * nothing is wrong with this particular save, config.json itself just cannot be trusted with a
   * write this session.
   */
  it("reports session-read-only once a read failure has suppressed writes for the session", async () => {
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(minimalConfig({ lastUsedInstallation: "still-here" })), "utf-8")

    const fse = (await import("fs-extra")).default
    // Persistent, not just-once: a single blip is retried once before the session gives up on the
    // file (see configManager.test.ts), so this needs the retry to fail too for suppression to stick.
    vi.spyOn(fse, "readFile").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }))

    const event = await createTrustedEvent()
    // Triggers the read failure that marks the session read-only (SAVE_CONFIG's own getConfig() call
    // below would otherwise be the first read).
    await getConfigHandler()(event)

    const result = await saveConfigHandler()(event, minimalConfig())
    assert.deepEqual(result, { ok: false, reason: "session-read-only" })
    assert.equal(JSON.parse(readFileSync(join(userDataFolder, "config.json"), "utf-8")).lastUsedInstallation, "still-here", "the config on disk from before the read failure is untouched")
  })
})

/**
 * #710: the renderer saves a VS Version before its download starts, and a launcher cut off during
 * the install (crash, power cut, update restart) never gets to say it finished. Whatever the
 * save wrote is all the next start has to go on, so the real handler and the real file are used.
 */
describe("SAVE_CONFIG with an install that has not finished", () => {
  it("still reads as an unfinished install on the next start", async () => {
    const event = await createTrustedEvent()
    const folder = join(appDataFolder, "RiftLauncherGameVersions", "1.22.7")
    const installing = { id: "gv-1", label: "1.22.7", version: "1.22.7", path: folder, _installing: true, incomplete: true }

    const result = await saveConfigHandler()(event, minimalConfig({ gameVersions: [installing] as unknown as GameVersionType[] }))
    assert.deepEqual(result, { ok: true })

    const onDisk = JSON.parse(readFileSync(join(userDataFolder, "config.json"), "utf-8"))
    assert.deepEqual(onDisk.gameVersions, [{ id: "gv-1", label: "1.22.7", version: "1.22.7", path: folder, incomplete: true }])

    vi.resetModules()
    await import("@src/ipc/handlers/configHandlers")
    const next = await getConfigHandler()(await createTrustedEvent())
    assert.equal(next.gameVersions[0]?.incomplete, true)
    assert.equal(next.gameVersions[0]?._installing, undefined)
  })

  it("writes a build that finished with no mark at all", async () => {
    const event = await createTrustedEvent()
    const folder = join(appDataFolder, "RiftLauncherGameVersions", "1.22.7")

    await saveConfigHandler()(event, minimalConfig({ gameVersions: [{ id: "gv-1", label: "1.22.7", version: "1.22.7", path: folder }] }))

    const onDisk = JSON.parse(readFileSync(join(userDataFolder, "config.json"), "utf-8"))
    assert.equal("incomplete" in onDisk.gameVersions[0], false)
  })
})
