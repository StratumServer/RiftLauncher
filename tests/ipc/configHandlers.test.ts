import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

function minimalConfig(overrides: Partial<ConfigType> = {}): ConfigType {
  return {
    schemaVersion: 1,
    lastUsedInstallation: null,
    defaultInstallationsFolder: join(appDataFolder, "RiftLauncherInstallations"),
    defaultVersionsFolder: join(appDataFolder, "RiftLauncherGameVersions"),
    backupsFolder: join(appDataFolder, "RiftLauncherBackups"),
    window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
    account: null,
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
    assert.deepEqual(result, { ok: false, reason: "unauthorized-path" })
  })

  it("saves an authorized config and reports ok: true", async () => {
    const event = await createTrustedEvent()
    const result = await saveConfigHandler()(event, minimalConfig())
    assert.deepEqual(result, { ok: true })

    // Round-trips through the real getConfig(), proving the write landed.
    const reread = await getConfigHandler()(event)
    assert.equal(reread.defaultInstallationsFolder, join(appDataFolder, "RiftLauncherInstallations"))
  })

  it("reports write-failed when the config file cannot be written", async () => {
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
})
