import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * Branch coverage for src/ipc/handlers/gameHandlers.ts (EXECUTE_GAME,
 * LOOK_FOR_A_GAME_VERSION), previously entirely unimported by a test (0%).
 *
 * Most tests here stop short of actually running Vintage Story: the refusal
 * and error arms this file mainly targets (bad shapes, unauthorized paths, an
 * unreadable version folder, a session write that cannot land) all resolve or
 * reject BEFORE gameHandlers.ts would call `child_process.spawn`. A few tests
 * ("...fails to actually start...") DO let a real `spawn()` run, deliberately,
 * against a file that has the executable bit set but is not a real executable
 * format: that fails fast with an "error" event (no child process ever
 * actually starts running), which is what a real, unmocked `realGameProcess`
 * needs to reach `gameProcessOutcomeToResult`'s `started: false` arm and the
 * `if (account && accountSecrets)` branches around it. What stays uncovered
 * is the started: true / actually-runs-to-completion path, and
 * `realProcessProbe`'s own timeout and successful-probe arms; see the PR
 * description for that gap.
 *
 * `@src/ipc/accountStore` is mocked directly (not electron's `safeStorage`,
 * which it wraps) for the one test that needs `getAccountSecrets()` to
 * resolve non-null: real secure storage is not available in a test process,
 * and mocking the narrow port this handler actually calls is more honest
 * than faking Electron's safeStorage API around it.
 */
vi.mock("@src/ipc/accountStore", () => ({
  getAccountSecrets: vi.fn(async () => ({ mptoken: null, sessionKey: "session-key", sessionSignature: "session-signature" }))
}))

type ExecuteGameHandler = (event: IpcMainInvokeEvent, version: unknown, installation: unknown) => Promise<GameExecutionResult>
type LookForAGameVersionHandler = (event: IpcMainInvokeEvent, path: unknown) => Promise<{ exists: boolean; installedGameVersion?: string }>

let temporaryRoot: string
let managedFolder: string
let versionsFolder: string
let backupsFolder: string
let userDataFolder: string

function executeGameHandler(): ExecuteGameHandler {
  return getIpcHandler<ExecuteGameHandler>(IPC_CHANNELS.GAME_MANAGER.EXECUTE_GAME)
}

function lookForAGameVersionHandler(): LookForAGameVersionHandler {
  return getIpcHandler<LookForAGameVersionHandler>(IPC_CHANNELS.GAME_MANAGER.LOOK_FOR_A_GAME_VERSION)
}

function baseInstallation(
  overrides: Partial<Pick<InstallationType, "path" | "startParams" | "mesaGlThread" | "envVars">> = {}
): Pick<InstallationType, "path" | "startParams" | "mesaGlThread" | "envVars"> {
  return { path: "", startParams: "", mesaGlThread: false, envVars: "", ...overrides }
}

/** Writes a fake config.json this run's configManager reads back through getConfig(). */
function writeConfig(config: Partial<ConfigType>): void {
  const fullConfig = {
    schemaVersion: 2,
    lastUsedInstallation: null,
    defaultInstallationsFolder: managedFolder,
    defaultVersionsFolder: versionsFolder,
    backupsFolder,
    window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
    account: null,
    installations: [],
    gameVersions: [],
    favMods: [],
    customIcons: [],
    ...config
  }
  writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(fullConfig), "utf-8")
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "game-handlers-"))
  managedFolder = join(temporaryRoot, "Installations")
  versionsFolder = join(temporaryRoot, "Versions")
  backupsFolder = join(temporaryRoot, "Backups")
  userDataFolder = join(temporaryRoot, "userData")
  mkdirSync(userDataFolder, { recursive: true })
  mkdirSync(managedFolder, { recursive: true })
  mkdirSync(versionsFolder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  vi.resetModules()
  await import("@src/ipc/handlers/gameHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("EXECUTE_GAME", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => executeGameHandler()(createUntrustedEvent(), { version: "1.0.0", path: versionsFolder }, baseInstallation()), /Unauthorized IPC sender/)
  })

  it("throws on a malformed game version", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => executeGameHandler()(event, { version: "1.0.0" /* missing path */ }, baseInstallation()), /Invalid game version/)
  })

  it("throws on a malformed installation", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => executeGameHandler()(event, { version: "1.0.0", path: versionsFolder }, { path: "/somewhere" /* missing startParams etc */ }), /Invalid start parameters/)
  })

  it("rejects a game version path nothing authorizes", async () => {
    writeConfig({})
    const event = await createTrustedEvent()
    const outsideVersion = join(temporaryRoot, "not-managed")
    mkdirSync(outsideVersion, { recursive: true })

    await assert.rejects(() => executeGameHandler()(event, { version: "1.0.0", path: outsideVersion }, baseInstallation({ path: managedFolder })), /Unmanaged game version path/)
  })

  it("resolves invalid-request when the installation's environment variables cannot be parsed", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeConfig({ gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder, envVars: "PATH=/malicious" }))

    assert.deepEqual(result, { ok: false, reason: "invalid-request" })
  })

  it("resolves no-executable when the version folder cannot be listed", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeConfig({ gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    chmodSync(gameVersionFolder, 0o000)
    try {
      const event = await createTrustedEvent()
      const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
      assert.deepEqual(result, { ok: false, reason: "no-executable" })
    } finally {
      chmodSync(gameVersionFolder, 0o700)
    }
  })

  it("resolves launch-failed when the executable is a symlink", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    const realTarget = join(temporaryRoot, "real-binary")
    writeFileSync(realTarget, "", "utf-8")
    symlinkSync(realTarget, join(gameVersionFolder, "Vintagestory"))
    writeConfig({ gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
    assert.deepEqual(result, { ok: false, reason: "launch-failed" })
  })

  it("resolves no-executable when the version folder holds none of the known game executables", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    // The folder exists and is readable (unlike the readdir-failure test
    // above, which never even reaches buildGameLaunchPlan), but names nothing
    // Linux would recognize as the game.
    writeFileSync(join(gameVersionFolder, "readme.txt"), "", "utf-8")
    writeConfig({ gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
    assert.deepEqual(result, { ok: false, reason: "no-executable" })
  })

  it("resolves launch-failed when a real, executable-bit file fails to actually start, with no account", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    // Not executable (no +x bit): assertExecutable only checks isFile()/
    // isSymbolicLink(), so this passes that check, but spawn() itself then
    // fails permission-denied with an "error" event before anything runs
    // (unlike a +x file with no shebang, which Node silently re-execs through
    // a shell on ENOEXEC and which would exit non-zero instead, i.e. "started").
    // That's what exercises the account-less branch of
    // "if (account && accountSecrets)" and gameProcessOutcomeToResult's
    // `started: false` arm.
    const executablePath = join(gameVersionFolder, "Vintagestory")
    writeFileSync(executablePath, "not a real binary", { mode: 0o644 })
    writeConfig({ gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
    assert.deepEqual(result, { ok: false, reason: "launch-failed" })
  })

  it("resolves launch-failed after successfully writing the account session first", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    const executablePath = join(gameVersionFolder, "Vintagestory")
    writeFileSync(executablePath, "not a real binary", { mode: 0o644 })
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      account: { email: "player@example.com", playerName: "Player", playerUid: "1", playerEntitlements: null, hostGameServer: false } as unknown as ConfigType["account"]
    })

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
    assert.deepEqual(result, { ok: false, reason: "launch-failed" })

    const { readFileSync } = await import("node:fs")
    const settings = JSON.parse(readFileSync(join(installationFolder, "clientsettings.json"), "utf-8"))
    assert.equal(settings.stringSettings.sessionkey, "session-key")
  })

  it("resolves session-write-failed when the account session cannot be written into clientsettings.json", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    // A real, non-symlink "Vintagestory" file is what buildGameLaunchPlan and
    // assertExecutable both need to see, on Linux, to hand back a plan instead
    // of a launchPlanFailureResult/invalidExecutableResult.
    writeFileSync(join(gameVersionFolder, "Vintagestory"), "", "utf-8")
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      account: { email: "player@example.com", playerName: "Player", playerUid: "1", playerEntitlements: null, hostGameServer: false } as unknown as ConfigType["account"]
    })

    // Read-only installation folder: clientsettings.json does not exist yet,
    // so JsonFile.read resolves { ok: true, document: undefined }, and the
    // write that follows is what fails.
    chmodSync(installationFolder, 0o500)
    try {
      const event = await createTrustedEvent()
      const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
      assert.deepEqual(result, { ok: false, reason: "session-write-failed" })
    } finally {
      chmodSync(installationFolder, 0o700)
    }
  })
})

describe("LOOK_FOR_A_GAME_VERSION", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => lookForAGameVersionHandler()(createUntrustedEvent(), versionsFolder), /Unauthorized IPC sender/)
  })

  it("reports not found when the folder cannot be listed", async () => {
    writeConfig({})
    const event = await createTrustedEvent()
    const missingFolder = join(versionsFolder, "does-not-exist")

    const result = await lookForAGameVersionHandler()(event, missingFolder)
    assert.deepEqual(result, { exists: false })
  })

  it("reports not found when the folder holds no known game executable", async () => {
    const emptyFolder = join(versionsFolder, "empty")
    mkdirSync(emptyFolder, { recursive: true })
    writeConfig({ gameVersions: [{ version: "1.20.0", path: emptyFolder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await lookForAGameVersionHandler()(event, emptyFolder)
    assert.deepEqual(result, { exists: false })
  })

  it("reports not found when the candidate executable fails its probe (a directory, not a file)", async () => {
    const folder = join(versionsFolder, "bad-executable")
    // A directory named like the Linux candidate: pickExecutable matches it by
    // name alone, so the probe is attempted, and assertExecutable's own
    // isFile() check is what refuses it -- no process ever spawns.
    mkdirSync(join(folder, "Vintagestory"), { recursive: true })
    writeConfig({ gameVersions: [{ version: "1.20.0", path: folder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await lookForAGameVersionHandler()(event, folder)
    assert.deepEqual(result, { exists: false })
  })

  it("reports not found when only the mono fallback candidate (Vintagestory.exe) is present and fails its probe", async () => {
    const folder = join(versionsFolder, "mono-fallback")
    // No "Vintagestory" (the native candidate checked first), so
    // pickExecutable falls through to "Vintagestory.exe", the mono-launched
    // candidate: probeRequestFor then runs assertExecutable against
    // request.args[0] instead of request.command.
    mkdirSync(join(folder, "Vintagestory.exe"), { recursive: true })
    writeConfig({ gameVersions: [{ version: "1.20.0", path: folder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await lookForAGameVersionHandler()(event, folder)
    assert.deepEqual(result, { exists: false })
  })
})
