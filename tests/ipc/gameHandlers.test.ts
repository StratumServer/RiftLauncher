import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { CURRENT_CONFIG_SCHEMA } from "@domain/config/migrations"
import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"

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
  getAccountSecrets: vi.fn(async () => ({ mptoken: null, sessionKey: "session-key", sessionSignature: "session-signature" })),
  saveAccountSecrets: vi.fn(async () => "saved" as const),
  adoptLegacySingleAccountSecrets: vi.fn(async () => false)
}))

// Real implementation, wrapped, so the crash-safety guarantee stays covered by
// atomicJsonFile.test.ts and this file only asserts that the settings write
// goes through the shared adapter rather than a bare fse.writeJSON.
vi.mock("@src/ipc/atomicJsonFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/ipc/atomicJsonFile")>()
  return { writeJsonAtomic: vi.fn(actual.writeJsonAtomic) }
})

type ExecuteGameHandler = (event: IpcMainInvokeEvent, version: unknown, installation: unknown) => Promise<GameExecutionResult>
type LookForAGameVersionHandler = (event: IpcMainInvokeEvent, path: unknown) => Promise<{ exists: boolean; installedGameVersion?: string }>

/** The key the game writes after prompting the player, which the launcher has never seen. */
const GAME_REFRESHED_KEY = "game-session-key"

/**
 * The game binary's file name on the host these tests run on.
 *
 * buildGameLaunchPlan, and detectInstalledGameVersion with it, looks for
 * `Vintagestory.exe` on Windows and the native `Vintagestory` on Linux, so a
 * fixture that hard-codes either name is only a game folder on one of the two.
 * On the other, the handler finds nothing and every test below gets
 * `no-executable` back instead of the outcome it was written for.
 */
const GAME_EXECUTABLE = process.platform === "win32" ? "Vintagestory.exe" : "Vintagestory"

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

/**
 * Writes a fake config.json this run's configManager reads back through getConfig().
 *
 * Written already at the current schema, not an older one: the schema-3-to-4 migration
 * unconditionally rebuilds `accounts`/`activeAccountId` from a legacy singular `account`
 * field this fixture never has, so writing at an old schema would silently wipe whatever
 * `accounts`/`activeAccountId` a test set here before the handler ever saw them.
 */
function writeConfig(config: Partial<ConfigType>): void {
  const fullConfig = {
    schemaVersion: CURRENT_CONFIG_SCHEMA,
    lastUsedInstallation: null,
    defaultInstallationsFolder: managedFolder,
    defaultVersionsFolder: versionsFolder,
    backupsFolder,
    window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
    accounts: [],
    activeAccountId: null,
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
  vi.mocked(writeJsonAtomic).mockClear()
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

  // chmod 0o000 cannot make a folder unlistable on Windows: NTFS has no POSIX
  // mode bits, so readdir succeeds there and the readdir-failure arm this
  // covers is unreachable.
  it.skipIf(process.platform === "win32")("resolves no-executable when the version folder cannot be listed", async () => {
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
    symlinkSync(realTarget, join(gameVersionFolder, GAME_EXECUTABLE))
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
    const executablePath = join(gameVersionFolder, GAME_EXECUTABLE)
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
    const executablePath = join(gameVersionFolder, GAME_EXECUTABLE)
    writeFileSync(executablePath, "not a real binary", { mode: 0o644 })
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [{ email: "player@example.com", playerName: "Player", playerUid: "1", playerEntitlements: null, hostGameServer: false }],
      activeAccountId: "1"
    })

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
    assert.deepEqual(result, { ok: false, reason: "launch-failed" })

    const { readFileSync } = await import("node:fs")
    const settings = JSON.parse(readFileSync(join(installationFolder, "clientsettings.json"), "utf-8"))
    assert.equal(settings.stringSettings.sessionkey, "session-key")

    // The merged document lands through the shared atomic-write adapter, not
    // a bare truncate write: this is the file that has no defaults to fall
    // back to if a crash mid-write ever left it missing.
    assert.deepEqual(vi.mocked(writeJsonAtomic).mock.calls.filter((call) => call[0] === join(installationFolder, "clientsettings.json")).length, 1)
  })

  // chmod 0o500 on the installation folder does not stop the write on Windows,
  // which gates writes on the file's own read-only attribute rather than on
  // POSIX write bits of the folder containing it.
  it.skipIf(process.platform === "win32")("resolves session-write-failed when the account session cannot be written into clientsettings.json", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    // A real, non-symlink "Vintagestory" file is what buildGameLaunchPlan and
    // assertExecutable both need to see, on Linux, to hand back a plan instead
    // of a launchPlanFailureResult/invalidExecutableResult.
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "", "utf-8")
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [{ email: "player@example.com", playerName: "Player", playerUid: "1", playerEntitlements: null, hostGameServer: false }],
      activeAccountId: "1"
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

  /**
   * With one saved account, a session store the launcher could not read was
   * harmless: whatever stale session the settings file held was that same
   * account's own. With more than one account possible, it can be a
   * housemate's, since the game writes their session there directly on their
   * own successful login. These three pin the guard that keeps a launch from
   * silently starting the game already signed in as somebody else.
   */
  it("clears another player's session before launching with no session of our own", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [{ email: "player@example.com", playerName: "Player", playerUid: "1", playerEntitlements: null, hostGameServer: false }],
      activeAccountId: "1"
    })
    writeFileSync(
      join(installationFolder, "clientsettings.json"),
      JSON.stringify({
        stringSettings: { sessionkey: "housemate-session-key", sessionsignature: "housemate-session-signature", mptoken: null, playeruid: "housemate-uid", playername: "Housemate" },
        intSettings: { maxFps: 60 }
      }),
      "utf-8"
    )

    const { getAccountSecrets } = await import("@src/ipc/accountStore")
    vi.mocked(getAccountSecrets).mockResolvedValueOnce(null)

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
    assert.deepEqual(result, { ok: false, reason: "launch-failed" }, "the launch itself still proceeds; only the foreign session is cleared")

    const { readFileSync } = await import("node:fs")
    const settings = JSON.parse(readFileSync(join(installationFolder, "clientsettings.json"), "utf-8"))
    assert.equal(settings.stringSettings.playeruid, undefined)
    assert.equal(settings.stringSettings.sessionkey, undefined)
    assert.deepEqual(settings.intSettings, { maxFps: 60 }, "everything else in the file survives")
  })

  it("leaves a settings file with no foreign session alone when we have none of our own", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [{ email: "player@example.com", playerName: "Player", playerUid: "1", playerEntitlements: null, hostGameServer: false }],
      activeAccountId: "1"
    })
    // playeruid "1" is our own account: not foreign, so nothing should change here.
    writeFileSync(
      join(installationFolder, "clientsettings.json"),
      JSON.stringify({ stringSettings: { sessionkey: "our-own-stale-key", sessionsignature: "our-own-signature", mptoken: null, playeruid: "1" } }),
      "utf-8"
    )

    const { getAccountSecrets } = await import("@src/ipc/accountStore")
    vi.mocked(getAccountSecrets).mockResolvedValueOnce(null)

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
    assert.deepEqual(result, { ok: false, reason: "launch-failed" })

    const { readFileSync } = await import("node:fs")
    const settings = JSON.parse(readFileSync(join(installationFolder, "clientsettings.json"), "utf-8"))
    assert.equal(settings.stringSettings.sessionkey, "our-own-stale-key", "our own session, even a stale one, is left exactly as it was")
  })

  // Same reason as the write test above: the read-only folder that blocks
  // writeJsonAtomic's rename on a POSIX filesystem does not block it on NTFS,
  // which has no such mode bits.
  it.skipIf(process.platform === "win32")("resolves session-write-failed when a foreign session cannot be cleared", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "", "utf-8")
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [{ email: "player@example.com", playerName: "Player", playerUid: "1", playerEntitlements: null, hostGameServer: false }],
      activeAccountId: "1"
    })
    const settingsPath = join(installationFolder, "clientsettings.json")
    writeFileSync(settingsPath, JSON.stringify({ stringSettings: { sessionkey: "housemate-key", playeruid: "housemate-uid" } }), "utf-8")

    const { getAccountSecrets } = await import("@src/ipc/accountStore")
    vi.mocked(getAccountSecrets).mockResolvedValueOnce(null)

    // The foreign session has to already be in the file for there to be anything to clear, so
    // unlike the "cannot be written" test above this one cannot start from an empty folder. What
    // blocks the write is still the DIRECTORY: the clear goes out through writeJsonAtomic, which
    // creates a sibling temp file and renames it over the destination, so the destination file's
    // own mode never gates it and only a directory nothing may create in does. 0o500 still allows
    // the read that finds the foreign uid in the first place.
    chmodSync(installationFolder, 0o500)
    try {
      const event = await createTrustedEvent()
      const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))
      assert.deepEqual(result, { ok: false, reason: "session-write-failed" })
    } finally {
      chmodSync(installationFolder, 0o700)
    }
  })

  /**
   * Issue #204: the launcher's stored session gets invalidated by a login
   * somewhere else, the game asks the player to log in and writes a working
   * session into clientsettings.json, and the next launch through the launcher
   * used to put the dead one straight back. These two pin the way out: the
   * game's session stays in the file and moves into the launcher's own store.
   */
  it("adopts the session the game refreshed instead of overwriting it", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [{ email: "player@example.com", playerName: "Player", playerUid: "1", playerEntitlements: null, hostGameServer: false }],
      activeAccountId: "1"
    })
    // What the game leaves behind after prompting: same account (playeruid "1"
    // is the one in the config above), a key the launcher has never seen.
    writeFileSync(
      join(installationFolder, "clientsettings.json"),
      JSON.stringify({
        stringSettings: { sessionkey: GAME_REFRESHED_KEY, sessionsignature: "game-session-signature", mptoken: "game-mp-token", playeruid: "1", playername: "Player" },
        intSettings: { maxFps: 60 }
      }),
      "utf-8"
    )

    const { saveAccountSecrets } = await import("@src/ipc/accountStore")
    const event = await createTrustedEvent()
    await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))

    assert.deepEqual(vi.mocked(saveAccountSecrets).mock.calls, [["1", { sessionKey: GAME_REFRESHED_KEY, sessionSignature: "game-session-signature", mptoken: "game-mp-token" }]])

    const { readFileSync } = await import("node:fs")
    const settings = JSON.parse(readFileSync(join(installationFolder, "clientsettings.json"), "utf-8"))
    assert.equal(settings.stringSettings.sessionkey, GAME_REFRESHED_KEY, "the launcher must not put its stale key back over the game's fresh one")
    assert.deepEqual(settings.intSettings, { maxFps: 60 })

    // Adoption is the no-write branch of writeClientSettingsSession: the file
    // already held the newer session, so nothing is written back. Coverage
    // for the write branch itself lives on the "writing the account session"
    // test above, where a write actually happens.
    assert.equal(vi.mocked(writeJsonAtomic).mock.calls.filter((call) => call[0] === join(installationFolder, "clientsettings.json")).length, 0)
  })

  it("says an adoption happened without ever putting the session in a log line", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [{ email: "player@example.com", playerName: "Player", playerUid: "1", playerEntitlements: null, hostGameServer: false }],
      activeAccountId: "1"
    })
    writeFileSync(
      join(installationFolder, "clientsettings.json"),
      JSON.stringify({ stringSettings: { sessionkey: GAME_REFRESHED_KEY, sessionsignature: "game-session-signature", mptoken: "game-mp-token", playeruid: "1" } }),
      "utf-8"
    )

    // Spied at the source, ahead of redactSensitiveText, so this asserts on
    // what the handler chose to say rather than on what the redactor saved it
    // from.
    const logSpy = vi.spyOn(await import("@src/utils/logManager"), "logMessage")
    const event = await createTrustedEvent()
    await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))

    const logged = logSpy.mock.calls.map(([, message]) => message)
    assert.ok(
      logged.some((message) => message.includes("Adopted it instead of overwriting it")),
      "an adoption should leave a trail"
    )
    for (const secret of [GAME_REFRESHED_KEY, "game-session-signature", "game-mp-token", "session-key"]) {
      assert.equal(
        logged.some((message) => message.includes(secret)),
        false,
        `a session value reached the log: ${secret}`
      )
    }
  })

  /**
   * The account a launch signs in as is the ACTIVE one, not the first saved one.
   * Every other fixture in this file saves exactly one account, which makes those
   * two indistinguishable: a handler that ignored activeAccountId entirely would
   * stay green through all of them (PR #253 review, finding 1). Two accounts, and
   * the uid that lands in clientsettings.json is what tells them apart.
   */
  it("signs in as the active account, not the first one saved", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [
        { email: "alice@example.com", playerName: "Alice", playerUid: "uid-a", playerEntitlements: null, hostGameServer: false },
        { email: "bob@example.com", playerName: "Bob", playerUid: "uid-b", playerEntitlements: null, hostGameServer: false }
      ],
      activeAccountId: "uid-b"
    })

    const { getAccountSecrets } = await import("@src/ipc/accountStore")
    vi.mocked(getAccountSecrets).mockClear()

    const event = await createTrustedEvent()
    await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))

    assert.deepEqual(vi.mocked(getAccountSecrets).mock.calls, [["uid-b"]], "the session is read out of the active account's store entry")

    const { readFileSync } = await import("node:fs")
    const settings = JSON.parse(readFileSync(join(installationFolder, "clientsettings.json"), "utf-8"))
    assert.equal(settings.stringSettings.playeruid, "uid-b", "switch to Bob and the next launch signs Bob in")
    assert.equal(settings.stringSettings.playername, "Bob")
    assert.equal(settings.stringSettings.useremail, "bob@example.com")
  })

  /**
   * Adoption is keyed on the account being launched, so a session the file holds
   * for SOMEBODY ELSE is overwritten, never carried into our own store entry. The
   * domain guard is pinned by clientSettings.test.ts (#209); this pins the call
   * site, which a single-account fixture leaves free to be keyed on anything.
   */
  it("overwrites another player's refreshed session instead of adopting it into the active account", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [
        { email: "alice@example.com", playerName: "Alice", playerUid: "uid-a", playerEntitlements: null, hostGameServer: false },
        { email: "bob@example.com", playerName: "Bob", playerUid: "uid-b", playerEntitlements: null, hostGameServer: false }
      ],
      activeAccountId: "uid-b"
    })
    // Alice logged in through the game on this installation: a key the launcher has never seen, under her uid.
    writeFileSync(
      join(installationFolder, "clientsettings.json"),
      JSON.stringify({
        stringSettings: { sessionkey: "alices-refreshed-key", sessionsignature: "alices-signature", mptoken: "alices-mp-token", playeruid: "uid-a", playername: "Alice" },
        intSettings: { maxFps: 60 }
      }),
      "utf-8"
    )

    const { saveAccountSecrets } = await import("@src/ipc/accountStore")
    vi.mocked(saveAccountSecrets).mockClear()

    const event = await createTrustedEvent()
    await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))

    const { readFileSync } = await import("node:fs")
    const settings = JSON.parse(readFileSync(join(installationFolder, "clientsettings.json"), "utf-8"))
    assert.equal(settings.stringSettings.playeruid, "uid-b", "a write, not an adoption")
    assert.equal(settings.stringSettings.sessionkey, "session-key")
    assert.equal(settings.stringSettings.playername, "Bob")
    assert.deepEqual(settings.intSettings, { maxFps: 60 }, "everything else in the file survives")
    assert.deepEqual(vi.mocked(saveAccountSecrets).mock.calls, [], "another player's key never reaches the active account's store entry")
  })

  /**
   * The adoption is keyed on the account being launched, the same as the write above
   * it. One saved account makes "the active account" and "the first saved account" the
   * same uid, so a call site keyed on either stays green through every other fixture
   * here; two accounts pull them apart. Keyed on the wrong one, the live session the
   * game just refreshed for Bob lands in Alice's store entry, and the next launch as
   * Alice signs the player in as Bob (PR #253 review, finding 1).
   */
  it("adopts the refreshed session under the active account's uid, not the first saved account's", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({
      gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      accounts: [
        { email: "alice@example.com", playerName: "Alice", playerUid: "uid-a", playerEntitlements: null, hostGameServer: false },
        { email: "bob@example.com", playerName: "Bob", playerUid: "uid-b", playerEntitlements: null, hostGameServer: false }
      ],
      activeAccountId: "uid-b"
    })
    // Bob is the active account and the game refreshed HIS session on this installation:
    // his own uid, and a key the launcher has never seen. The #204 adoption case exactly,
    // only with a second account saved ahead of him.
    writeFileSync(
      join(installationFolder, "clientsettings.json"),
      JSON.stringify({
        stringSettings: { sessionkey: GAME_REFRESHED_KEY, sessionsignature: "game-session-signature", mptoken: "game-mp-token", playeruid: "uid-b", playername: "Bob" },
        intSettings: { maxFps: 60 }
      }),
      "utf-8"
    )

    const { saveAccountSecrets } = await import("@src/ipc/accountStore")
    vi.mocked(saveAccountSecrets).mockClear()

    const event = await createTrustedEvent()
    await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))

    assert.deepEqual(
      vi.mocked(saveAccountSecrets).mock.calls,
      [["uid-b", { sessionKey: GAME_REFRESHED_KEY, sessionSignature: "game-session-signature", mptoken: "game-mp-token" }]],
      "the adopted session is stored under the uid it was issued for, and under no other"
    )
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
    mkdirSync(join(folder, GAME_EXECUTABLE), { recursive: true })
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
