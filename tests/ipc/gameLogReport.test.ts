import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync, closeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { CURRENT_CONFIG_SCHEMA } from "@domain/config/migrations"

/**
 * GET_GAME_LOG_REPORT end to end: the validators it holds to, the bounded read, and the promise
 * that nothing a game log carries reaches the renderer unredacted (#462).
 */

type GetGameLogReportHandler = (event: IpcMainInvokeEvent, installationPath: unknown) => Promise<GameLogReportResult>

let temporaryRoot: string
let managedFolder: string
let installationFolder: string
let logsFolder: string
let userDataFolder: string

function handler(): GetGameLogReportHandler {
  return getIpcHandler<GetGameLogReportHandler>(IPC_CHANNELS.GAME_MANAGER.GET_GAME_LOG_REPORT)
}

function writeConfig(config: Partial<ConfigType>): void {
  writeFileSync(
    join(userDataFolder, "config.json"),
    JSON.stringify({
      schemaVersion: CURRENT_CONFIG_SCHEMA,
      lastUsedInstallation: null,
      defaultInstallationsFolder: managedFolder,
      defaultVersionsFolder: join(temporaryRoot, "Versions"),
      backupsFolder: join(temporaryRoot, "Backups"),
      window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
      accounts: [],
      activeAccountId: null,
      installations: [{ id: "inst-1", name: "Main", path: installationFolder, backups: [] }],
      gameVersions: [],
      favMods: [],
      customIcons: [],
      ...config
    }),
    "utf-8"
  )
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "game-log-report-"))
  managedFolder = join(temporaryRoot, "Installations")
  installationFolder = join(managedFolder, "Main")
  logsFolder = join(installationFolder, "Logs")
  userDataFolder = join(temporaryRoot, "userData")
  mkdirSync(logsFolder, { recursive: true })
  mkdirSync(userDataFolder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))
  writeConfig({})

  vi.resetModules()
  await import("@src/ipc/handlers/gameHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("GET_GAME_LOG_REPORT boundaries", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => handler()(createUntrustedEvent(), installationFolder), /Unauthorized IPC sender/)
  })

  it("refuses a path that is not an Installation the config names", async () => {
    const event = await createTrustedEvent()
    // A folder inside the managed installations root, but not an Installation: assertManagedPath
    // alone would admit it, which is exactly why this channel uses the narrower validator.
    const beside = join(managedFolder, "NotAnInstallation")
    mkdirSync(join(beside, "Logs"), { recursive: true })
    writeFileSync(join(beside, "Logs", "client-main.log"), "1.1.2026 0:00:00 [Error] boom", "utf-8")

    assert.deepEqual(await handler()(event, beside), { ok: false, reason: "refused" })
    assert.deepEqual(await handler()(event, join(temporaryRoot, "elsewhere")), { ok: false, reason: "refused" })
    assert.deepEqual(await handler()(event, 42), { ok: false, reason: "refused" })
  })

  it("says so plainly when the Installation has no logs yet", async () => {
    const event = await createTrustedEvent()
    assert.deepEqual(await handler()(event, installationFolder), { ok: false, reason: "no-logs" })
  })
})

describe("GET_GAME_LOG_REPORT on a real session", () => {
  it("builds the report from the main log and the crash file", async () => {
    writeFileSync(
      join(logsFolder, "client-main.log"),
      ["22.2.2026 20:39:01 [Notification] Entering runphase Initialization", "22.2.2026 20:39:08 [Error] [egocaribautomapmarkers] could not patch BlockTallGrass"].join("\n"),
      "utf-8"
    )
    writeFileSync(
      join(logsFolder, "client-crash.txt"),
      [
        "Running on 64 bit Linux 6.6.0 with 32000 MB RAM",
        "22.02.2026 20:39:11: Critical error occurred in the following mod: egocaribautomapmarkers@4.0.3",
        "System.TypeLoadException: Could not load type 'Vintagestory.GameContent.BlockTallGrass'",
        "   at Egocarib.AutoMapMarkers.Patches.Block.Postfix(BlockSelection blockSel)"
      ].join("\n"),
      "utf-8"
    )

    const answer = await handler()(await createTrustedEvent(), installationFolder)
    assert.equal(answer.ok, true)
    assert.ok(answer.ok)
    assert.equal(answer.report.verdict.kind, "crashed-in-mod")
    assert.equal(answer.report.verdict.modLabel, "egocaribautomapmarkers")
    assert.equal(answer.report.crash?.exceptionType, "System.TypeLoadException")
    assert.equal(answer.report.mods[0]?.modid, "egocaribautomapmarkers")
    assert.equal(answer.report.source.fileName, "client-main.log")
    assert.ok((answer.report.source.lastWrittenAtMs ?? 0) > 0)
  })

  it("never lets a path or the player's own account out of the process", async () => {
    writeConfig({ accounts: [{ email: "will@example.com", playerName: "Will_T", playerUid: "uid-1", playerEntitlements: null, hostGameServer: false }], activeAccountId: "uid-1" })
    writeFileSync(
      join(logsFolder, "client-main.log"),
      [
        "1.1.2026 0:00:00 [Error] [ancienttools] failed reading C:\\Users\\Will\\AppData\\Roaming\\Vintagestory\\config.json",
        "1.1.2026 0:00:01 [Error] sessionkey=abc123 player Will_T (will@example.com)"
      ].join("\n"),
      "utf-8"
    )

    const answer = await handler()(await createTrustedEvent(), installationFolder)
    assert.ok(answer.ok)
    const wire = JSON.stringify(answer.report)
    assert.ok(!wire.includes("C:\\\\Users"), "a Windows path crossed IPC")
    assert.ok(!wire.includes("abc123"), "a token value crossed IPC")
    assert.ok(!wire.includes("will@example.com"), "the player's email crossed IPC")
    assert.ok(!wire.includes("Will_T"), "the player's name crossed IPC")
  })

  it("reads a 50 MiB log bounded, keeping both ends and saying the middle was skipped", async () => {
    const head = "1.1.2026 0:00:00 [Notification] Entering runphase Initialization\n"
    const tail = "\n1.1.2026 0:09:00 [Error] [lategamemod] the very last error\n"
    const filler = `${"1.1.2026 0:00:30 [Notification] filler ".padEnd(1023, "x")}\n`

    const file = openSync(join(logsFolder, "client-main.log"), "w")
    try {
      writeSync(file, head)
      for (let written = 0; written < 50 * 1024 * 1024; written += filler.length) writeSync(file, filler)
      writeSync(file, tail)
    } finally {
      closeSync(file)
    }

    const startedAt = performance.now()
    const answer = await handler()(await createTrustedEvent(), installationFolder)
    const elapsed = performance.now() - startedAt

    assert.ok(answer.ok)
    assert.equal(answer.report.source.truncated, true)
    // The head is where the phase timeline lives, the tail is where the errors are. Both survive.
    assert.deepEqual(
      answer.report.startup.phases.map((phase) => phase.name),
      ["Initialization"]
    )
    assert.equal(answer.report.mods[0]?.modid, "lategamemod")
    // Bounded, not whole: reading 50 MiB into the main process and parsing it would not land here.
    assert.ok(elapsed < 5_000, `the bounded read took ${Math.round(elapsed)} ms, which is not bounded`)
  })
})
