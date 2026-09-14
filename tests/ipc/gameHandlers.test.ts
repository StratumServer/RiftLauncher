import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
 * `if (account && accountSecrets)` branches around it. The launch-wrapper
 * tests do let a real `#!/bin/sh` script run to completion, so the
 * started: true path is covered on Linux; `realProcessProbe`'s own timeout
 * and successful-probe arms are still the gap, see the PR description.
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

/**
 * Makes the next spawn throw the way Windows throws, on demand.
 *
 * `child_process.spawn` reports ENOENT, EACCES, EAGAIN, EMFILE and ENFILE
 * through an "error" event and throws every other failure synchronously. Linux
 * answers this file's fixtures with EACCES and so only ever takes the event
 * path, while Windows answers a file that is not a real executable with
 * UNKNOWN and takes the throw path, which used to reject the whole handler.
 * Every other test here keeps the real spawn: the flag is off unless a test
 * turns it on.
 */
const spawnThrow = vi.hoisted(() => ({ next: false }))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>): ReturnType<typeof actual.spawn> => {
      if (!spawnThrow.next) return actual.spawn(...args)
      spawnThrow.next = false
      throw Object.assign(new Error("spawn UNKNOWN"), { code: "UNKNOWN", errno: -4094, syscall: "spawn" })
    }
  }
})

/**
 * Stands one detection result in for the domain's, on demand.
 *
 * The boundary check the handler runs on the way out reads the same semver
 * grammar detection reads on the way in, so no transcript a real probe could
 * print produces a variant the domain accepts and the check refuses: a test
 * driving a script can only ever watch the two agree. Queueing a result here is
 * what hands the handler a variant the check has to catch, which pins the call
 * itself rather than the function it calls. Off unless a test turns it on, like
 * the spawn flag above, and consumed by the first detection after it is set.
 */
const detectedVersion = vi.hoisted(() => ({ next: null as unknown }))

/**
 * Stands Windows in for the host, on demand, so the Windows arms of EXECUTE_GAME can be driven
 * from a Linux runner.
 *
 * Only `os.platform()` moves. `comparablePath` and the path policy read `process.platform`
 * instead, so a fixture path still compares the way the real host compares it, and every other
 * `node:os` export is the real one. The handler reads the platform for three decisions: the launch
 * wrapper (Linux only), the launch plan's executable name, and which process sampler the session
 * recorder gets. That last one is the point: the Windows sampler is a `tasklist` reader, so it only
 * measures anything if the handler hands the factory a probe to run it with.
 */
const hostPlatform = vi.hoisted(() => ({ value: null as NodeJS.Platform | null }))

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  const platform = (): NodeJS.Platform => hostPlatform.value ?? actual.platform()
  // gameHandlers.ts imports the default, which the interop resolves to the namespace, so both have
  // to carry the stand-in or the handler keeps reading the real platform.
  return { ...actual, platform, default: { ...actual, platform } }
})

vi.mock("@domain/versions/detect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@domain/versions/detect")>()
  type Detect = typeof actual.detectInstalledGameVersion
  return {
    ...actual,
    detectInstalledGameVersion: async (...args: Parameters<Detect>): ReturnType<Detect> => {
      const queued = detectedVersion.next
      detectedVersion.next = null
      return queued ? (queued as Awaited<ReturnType<Detect>>) : actual.detectInstalledGameVersion(...args)
    }
  }
})

// Real implementation, wrapped, so the crash-safety guarantee stays covered by
// atomicJsonFile.test.ts and this file only asserts that the settings write
// goes through the shared adapter rather than a bare fse.writeJSON.
vi.mock("@src/ipc/atomicJsonFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/ipc/atomicJsonFile")>()
  return { writeJsonAtomic: vi.fn(actual.writeJsonAtomic) }
})

type ExecuteGameHandler = (event: IpcMainInvokeEvent, version: unknown, installation: unknown, serverId?: unknown) => Promise<GameExecutionResult>
type LookForAGameVersionHandler = (event: IpcMainInvokeEvent, path: unknown) => Promise<{ exists: boolean; installedGameVersion?: string; variant?: GameBuildVariantType }>

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
  overrides: Partial<Pick<InstallationType, "path" | "startParams" | "mesaGlThread" | "envVars" | "launchWrapper">> = {}
): Pick<InstallationType, "path" | "startParams" | "mesaGlThread" | "envVars"> & { launchWrapper?: string } {
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
  // vi.restoreAllMocks() in afterEach does not reach a vi.hoisted object, so a
  // test that turns this on and fails before the spawn consumes it would leave
  // it on for the next test, whose real spawn would then throw.
  spawnThrow.next = false
  detectedVersion.next = null
  hostPlatform.value = null

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

  it("rejects a launch when the version id and installation gameVersionId do not correlate", async () => {
    const gameVersionFolder = join(versionsFolder, "vanilla")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeConfig({ gameVersions: [{ id: "gv-vanilla", version: "1.22.7", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const version = { id: "gv-vanilla", version: "1.22.7", path: gameVersionFolder }
    const installation = { ...baseInstallation({ path: installationFolder }), gameVersionId: "gv-optimum" }

    await assert.rejects(() => executeGameHandler()(event, version, installation), /same game version|gameVersionId|correlate/i)
  })

  it("accepts matching version identities and reaches the launch checks", async () => {
    const gameVersionFolder = join(versionsFolder, "matching")
    const installationFolder = join(managedFolder, "Matching")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeConfig({ gameVersions: [{ id: "gv-matching", version: "1.22.7", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const version = { id: "gv-matching", version: "1.22.7", path: gameVersionFolder }
    const installation = { ...baseInstallation({ path: installationFolder }), gameVersionId: "gv-matching" }

    const result = await executeGameHandler()(event, version, installation)

    assert.deepEqual(result, { ok: false, reason: "no-executable" })
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

  it.skipIf(process.platform !== "linux")("refuses a configured wrapper that cannot be resolved", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({ gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(
      event,
      { version: "1.20.0", path: gameVersionFolder },
      baseInstallation({ path: installationFolder, launchWrapper: "riftlauncher-wrapper-that-is-not-installed" })
    )

    assert.deepEqual(result, { ok: false, reason: "launch-failed" })
  })

  /**
   * The one test that runs a wrapper and a game to completion. Everything either side of the
   * wrapper is real: resolveLaunchWrapper resolves the absolute path, buildGameLaunchPlan puts it
   * in front of the game command, and realGameProcess spawns it with shell: false. Both fixtures
   * dump their own argv, so this pins that the wrapper receives the exact game command and that the
   * game receives exactly what it would have without one, start parameters still one argv entry.
   */
  it.skipIf(process.platform !== "linux")("runs the game through a configured wrapper and hands it the exact game command", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })

    const wrapperArgvFile = join(temporaryRoot, "wrapper-argv")
    const gameArgvFile = join(temporaryRoot, "game-argv")
    const wrapperPath = join(temporaryRoot, "fake-wrapper")
    const executablePath = join(gameVersionFolder, GAME_EXECUTABLE)

    writeFileSync(wrapperPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${wrapperArgvFile}'\nexec "$@"\n`)
    writeFileSync(executablePath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${gameArgvFile}'\n`)
    chmodSync(wrapperPath, 0o755)
    chmodSync(executablePath, 0o755)
    writeConfig({ gameVersions: [{ id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(
      event,
      { id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder },
      { ...baseInstallation({ path: installationFolder, startParams: "--openWorld My World", launchWrapper: wrapperPath }), gameVersionId: "gv-1.20.0" }
    )

    assert.deepEqual(result, { ok: true, exitCode: 0 })
    assert.deepEqual(readFileSync(wrapperArgvFile, "utf-8").split("\n").slice(0, -1), [executablePath, `--dataPath=${installationFolder}`, "--openWorld My World"])
    assert.deepEqual(readFileSync(gameArgvFile, "utf-8").split("\n").slice(0, -1), [`--dataPath=${installationFolder}`, "--openWorld My World"])
  })

  /**
   * The session recorder, end to end on Linux: a real spawn, a real pid, a real `/proc` read.
   *
   * The fixture sleeps long enough for the reading taken the moment the process exists to land, so
   * the file that ends up under the launcher's own Sessions folder carries what the sampler
   * actually measured rather than an empty series.
   */
  it.skipIf(process.platform !== "linux")("records the session it measured under the launcher's own Sessions folder", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "#!/bin/sh\nsleep 1\nexit 0\n")
    chmodSync(join(gameVersionFolder, GAME_EXECUTABLE), 0o755)

    writeConfig({
      gameVersions: [{ id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      installations: [{ id: "main-1", path: installationFolder, backups: [] }] as unknown as ConfigType["installations"]
    })

    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder }, { ...baseInstallation({ path: installationFolder }), gameVersionId: "gv-1.20.0" })

    assert.deepEqual(result, { ok: true, exitCode: 0 })
    const document = JSON.parse(readFileSync(join(userDataFolder, "Sessions", "main-1.json"), "utf-8"))
    assert.equal(document.format, 1)
    assert.equal(document.sessions.length, 1)
    assert.equal(document.sessions[0].partial, false)
    assert.ok(document.sessions[0].samples.length >= 1, "the session landed with no readings in it")
    assert.ok(document.sessions[0].samples[0].rssBytes > 0, "the reading carries no memory")
  })

  it.skipIf(process.platform !== "linux")("measures nothing at all when the setting is off", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    // The same fixture the test above records a session from, so "nothing was written" can only be
    // the setting and never the game exiting before a reading could land.
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "#!/bin/sh\nsleep 1\nexit 0\n")
    chmodSync(join(gameVersionFolder, GAME_EXECUTABLE), 0o755)

    writeConfig({
      measurePlaySessions: false,
      gameVersions: [{ id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
      installations: [{ id: "main-1", path: installationFolder, backups: [] }] as unknown as ConfigType["installations"]
    })

    const event = await createTrustedEvent()
    await executeGameHandler()(event, { id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder }, { ...baseInstallation({ path: installationFolder }), gameVersionId: "gv-1.20.0" })

    assert.equal(existsSync(join(userDataFolder, "Sessions")), false)
  })

  /**
   * The Windows sampler, from EXECUTE_GAME rather than from the adapter's own tests.
   *
   * The handler builds the sampler itself, so nothing below the handler can prove that a Windows
   * launch is measured at all: hand `createProcessSampler` no probe and it answers the absent
   * sampler, the session records nothing, and every test under the handler still passes. These
   * three drive the real factory, the real `tasklist` adapter and the real probe, with only the
   * platform and the `tasklist` binary itself standing in.
   *
   * Still Linux-only, because the stand-ins are `#!/bin/sh` scripts: the launcher believes it is on
   * Windows, the runner is not. A launch plan for Windows spawns `Vintagestory.exe` directly, and a
   * shell script under that name runs perfectly well on Linux.
   */
  describe("with a Windows sampler", () => {
    let tasklistCalls: string

    /**
     * Puts a stand-in `tasklist` first on PATH, which is where `execFile` looks for a bare command.
     *
     * It records the arguments it was given before answering, so a test can tell a sampler that ran
     * and got nothing usable apart from one that was never built.
     */
    function fakeTasklist(body: string): void {
      const binFolder = join(temporaryRoot, "bin")
      mkdirSync(binFolder, { recursive: true })
      tasklistCalls = join(temporaryRoot, "tasklist-calls")
      writeFileSync(join(binFolder, "tasklist"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tasklistCalls}'\n${body}`)
      chmodSync(join(binFolder, "tasklist"), 0o755)
      process.env.PATH = `${binFolder}:${process.env.PATH ?? ""}`
    }

    /** A Windows game folder and Installation, with the game itself sleeping long enough to be measured once. */
    function seedWindowsLaunch(): { gameVersionFolder: string; installationFolder: string } {
      const gameVersionFolder = join(versionsFolder, "1.20.0")
      const installationFolder = join(managedFolder, "Main")
      mkdirSync(gameVersionFolder, { recursive: true })
      mkdirSync(installationFolder, { recursive: true })
      writeFileSync(join(gameVersionFolder, "Vintagestory.exe"), "#!/bin/sh\nsleep 1\nexit 0\n")
      chmodSync(join(gameVersionFolder, "Vintagestory.exe"), 0o755)

      writeConfig({
        gameVersions: [{ id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
        installations: [{ id: "main-1", path: installationFolder, backups: [] }] as unknown as ConfigType["installations"]
      })
      return { gameVersionFolder, installationFolder }
    }

    async function launch(gameVersionFolder: string, installationFolder: string): Promise<GameExecutionResult> {
      const event = await createTrustedEvent()
      return executeGameHandler()(event, { id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder }, { ...baseInstallation({ path: installationFolder }), gameVersionId: "gv-1.20.0" })
    }

    let originalPath: string | undefined

    beforeEach(() => {
      originalPath = process.env.PATH
      hostPlatform.value = "win32"
    })

    afterEach(() => {
      process.env.PATH = originalPath
    })

    it.skipIf(process.platform !== "linux")("stores what tasklist reported for a Windows launch", async () => {
      fakeTasklist(`echo '"Vintagestory.exe","4242","Console","1","65,536 K"'\n`)
      const { gameVersionFolder, installationFolder } = seedWindowsLaunch()

      assert.deepEqual(await launch(gameVersionFolder, installationFolder), { ok: true, exitCode: 0 })

      assert.match(readFileSync(tasklistCalls, "utf-8"), /\/FI PID eq \d+ \/NH \/FO CSV/, "the sampler never ran tasklist for the pid the launcher spawned")
      const document = JSON.parse(readFileSync(join(userDataFolder, "Sessions", "main-1.json"), "utf-8"))
      assert.equal(document.sessions.length, 1)
      assert.equal(document.sessions[0].partial, false)
      assert.deepEqual(
        document.sessions[0].samples.map((sample: { rssBytes: number }) => sample.rssBytes),
        [65_536 * 1024]
      )
      // tasklist carries no CPU column, so a Windows reading is memory and nothing else.
      assert.equal(document.sessions[0].samples[0].cpuPercent, undefined)
    })

    /**
     * The game exited between samples: `tasklist` still answers, and answers that the pid is gone.
     * A session with no reading in it is not written at all, which is the recorder's own answer for
     * one it never measured, and the launch result reaches the player unchanged.
     */
    it.skipIf(process.platform !== "linux")("records no session, and still answers the launch, when the process has gone", async () => {
      fakeTasklist("echo 'INFO: No tasks are running which match the specified criteria.'\n")
      const { gameVersionFolder, installationFolder } = seedWindowsLaunch()

      assert.deepEqual(await launch(gameVersionFolder, installationFolder), { ok: true, exitCode: 0 })

      assert.match(readFileSync(tasklistCalls, "utf-8"), /\/FI PID eq \d+/, "the sampler never ran tasklist for the pid the launcher spawned")
      assert.equal(existsSync(join(userDataFolder, "Sessions", "main-1.json")), false)
    })

    /** A process another account owns: `tasklist` refuses it, which is a reading the session does without. */
    it.skipIf(process.platform !== "linux")("records no session, and still answers the launch, when tasklist is denied the process", async () => {
      fakeTasklist("echo 'ERROR: Access is denied.' >&2\nexit 1\n")
      const { gameVersionFolder, installationFolder } = seedWindowsLaunch()

      assert.deepEqual(await launch(gameVersionFolder, installationFolder), { ok: true, exitCode: 0 })

      assert.match(readFileSync(tasklistCalls, "utf-8"), /\/FI PID eq \d+/, "the sampler never ran tasklist for the pid the launcher spawned")
      assert.equal(existsSync(join(userDataFolder, "Sessions", "main-1.json")), false)
    })
  })

  /**
   * The server-bookmark half of #460, run end to end through the same argv-dumping fixture the
   * wrapper test uses. What is being pinned is that the handler builds the URL from the record it
   * finds in ITS OWN config, and that an id naming nothing never reaches a spawn at all.
   */
  describe("joining a saved server", () => {
    const bookmark = { id: "s-1", name: "Home", host: "play.example.com", port: 42_420, lastLaunched: -1 }

    /** Writes a game that dumps its argv, and a config where installation `i-1` owns `bookmark`. */
    function seedJoinFixture(): { installationFolder: string; gameVersionFolder: string; gameArgvFile: string } {
      const gameVersionFolder = join(versionsFolder, "1.20.0")
      const installationFolder = join(managedFolder, "Main")
      mkdirSync(gameVersionFolder, { recursive: true })
      mkdirSync(installationFolder, { recursive: true })

      const gameArgvFile = join(temporaryRoot, "game-argv")
      const executablePath = join(gameVersionFolder, GAME_EXECUTABLE)
      writeFileSync(executablePath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${gameArgvFile}'\n`)
      chmodSync(executablePath, 0o755)

      writeConfig({
        gameVersions: [{ id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"],
        installations: [
          { id: "i-1", path: installationFolder, servers: [bookmark] },
          { id: "i-2", path: join(managedFolder, "Other"), servers: [{ ...bookmark, id: "s-2", host: "other.example.com" }] }
        ] as unknown as ConfigType["installations"]
      })

      return { installationFolder, gameVersionFolder, gameArgvFile }
    }

    function joinRequest(installationFolder: string, gameVersionFolder: string): [unknown, unknown] {
      return [
        { id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder },
        { ...baseInstallation({ path: installationFolder, startParams: "--openWorld My World" }), id: "i-1", gameVersionId: "gv-1.20.0" }
      ]
    }

    it.skipIf(process.platform !== "linux")("hands the game a connect pair built from the stored bookmark, start parameters still one argument", async () => {
      const { installationFolder, gameVersionFolder, gameArgvFile } = seedJoinFixture()
      const event = await createTrustedEvent()
      const [version, installation] = joinRequest(installationFolder, gameVersionFolder)

      const result = await executeGameHandler()(event, version, installation, "s-1")

      assert.deepEqual(result, { ok: true, exitCode: 0 })
      assert.deepEqual(readFileSync(gameArgvFile, "utf-8").split("\n").slice(0, -1), [`--dataPath=${installationFolder}`, "-c", "vintagestoryjoin://play.example.com:42420", "--openWorld My World"])
    })

    it.skipIf(process.platform !== "linux")("starts the game with no connect pair when no server was asked for", async () => {
      const { installationFolder, gameVersionFolder, gameArgvFile } = seedJoinFixture()
      const event = await createTrustedEvent()
      const [version, installation] = joinRequest(installationFolder, gameVersionFolder)

      const result = await executeGameHandler()(event, version, installation)

      assert.deepEqual(result, { ok: true, exitCode: 0 })
      assert.deepEqual(readFileSync(gameArgvFile, "utf-8").split("\n").slice(0, -1), [`--dataPath=${installationFolder}`, "--openWorld My World"])
    })

    it("refuses an id this Installation has not saved, and never spawns anything", async () => {
      const { installationFolder, gameVersionFolder, gameArgvFile } = seedJoinFixture()
      const event = await createTrustedEvent()
      const [version, installation] = joinRequest(installationFolder, gameVersionFolder)

      const result = await executeGameHandler()(event, version, installation, "s-does-not-exist")

      assert.deepEqual(result, { ok: false, reason: "invalid-request" })
      assert.equal(existsSync(gameArgvFile), false, "nothing may be spawned for a bookmark that does not exist")
    })

    it("refuses another Installation's bookmark id, and never spawns anything", async () => {
      const { installationFolder, gameVersionFolder, gameArgvFile } = seedJoinFixture()
      const event = await createTrustedEvent()
      const [version, installation] = joinRequest(installationFolder, gameVersionFolder)

      const result = await executeGameHandler()(event, version, installation, "s-2")

      assert.deepEqual(result, { ok: false, reason: "invalid-request" })
      assert.equal(existsSync(gameArgvFile), false, "one Installation's servers are not another's")
    })

    it("refuses a bookmark id when the request carries no Installation id to look it up under", async () => {
      const { installationFolder, gameVersionFolder } = seedJoinFixture()
      const event = await createTrustedEvent()

      const result = await executeGameHandler()(
        event,
        { id: "gv-1.20.0", version: "1.20.0", path: gameVersionFolder },
        { ...baseInstallation({ path: installationFolder }), gameVersionId: "gv-1.20.0" },
        "s-1"
      )

      assert.deepEqual(result, { ok: false, reason: "invalid-request" })
    })

    it("throws on a server id that is not a bounded string, which no player can send", async () => {
      const { installationFolder, gameVersionFolder } = seedJoinFixture()
      const event = await createTrustedEvent()
      const [version, installation] = joinRequest(installationFolder, gameVersionFolder)

      for (const bad of [42, null, {}, "x".repeat(129), "vintagestoryjoin://evil.example.com:1"]) {
        if (bad === "vintagestoryjoin://evil.example.com:1") {
          // A string of the right shape is not a throw, it is simply an id that names nothing.
          assert.deepEqual(await executeGameHandler()(event, version, installation, bad), { ok: false, reason: "invalid-request" })
          continue
        }
        await assert.rejects(() => executeGameHandler()(event, version, installation, bad), /Invalid server bookmark id/, String(bad))
      }
    })
  })

  /**
   * A PATH entry that is itself relative used to be checked against the launcher's own working
   * directory and then executed against the spawned process's, which is the version folder. The
   * decoy below is what the old lookup would have run.
   */
  it.skipIf(process.platform !== "linux")("skips a relative PATH entry instead of resolving a wrapper against the version folder", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(join(gameVersionFolder, "wrapper-bin"), { recursive: true })
    mkdirSync(join(temporaryRoot, "wrapper-bin"), { recursive: true })
    mkdirSync(installationFolder, { recursive: true })

    const decoyMarker = join(temporaryRoot, "decoy-ran")
    writeFileSync(join(temporaryRoot, "wrapper-bin", "fakewrap"), "#!/bin/sh\nexit 0\n")
    writeFileSync(join(gameVersionFolder, "wrapper-bin", "fakewrap"), `#!/bin/sh\n: > '${decoyMarker}'\nexec "$@"\n`)
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "#!/bin/sh\nexit 0\n")
    chmodSync(join(temporaryRoot, "wrapper-bin", "fakewrap"), 0o755)
    chmodSync(join(gameVersionFolder, "wrapper-bin", "fakewrap"), 0o755)
    chmodSync(join(gameVersionFolder, GAME_EXECUTABLE), 0o755)
    writeConfig({ gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    const originalPath = process.env.PATH
    const originalCwd = process.cwd()
    try {
      process.chdir(temporaryRoot)
      process.env.PATH = "wrapper-bin"
      const event = await createTrustedEvent()
      const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder, launchWrapper: "fakewrap" }))

      assert.deepEqual(result, { ok: false, reason: "launch-failed" })
      assert.equal(existsSync(decoyMarker), false, "the version folder's own wrapper-bin/fakewrap must never run")
    } finally {
      process.chdir(originalCwd)
      process.env.PATH = originalPath
    }
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

  /**
   * A spawn that throws instead of emitting is still a launch that did not
   * happen, and this handler's whole contract is that a launch a player can
   * fail to complete comes back as a reason rather than as an exception. It
   * only shows up on Windows, where a Vintagestory.exe that is not a valid
   * executable (a truncated download, a file antivirus emptied) is answered
   * with UNKNOWN rather than with one of the five codes spawn reports through
   * an event. Both spawns in this file were written for the event alone.
   */
  it("resolves launch-failed when the spawn throws instead of emitting an error", async () => {
    const gameVersionFolder = join(versionsFolder, "1.20.0")
    const installationFolder = join(managedFolder, "Main")
    mkdirSync(gameVersionFolder, { recursive: true })
    mkdirSync(installationFolder, { recursive: true })
    writeFileSync(join(gameVersionFolder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({ gameVersions: [{ version: "1.20.0", path: gameVersionFolder }] as unknown as ConfigType["gameVersions"] })

    spawnThrow.next = true
    const event = await createTrustedEvent()
    const result = await executeGameHandler()(event, { version: "1.20.0", path: gameVersionFolder }, baseInstallation({ path: installationFolder }))

    assert.deepEqual(result, { ok: false, reason: "launch-failed" })
    assert.equal(spawnThrow.next, false, "the throwing spawn is the one this test ran")
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

describe("GET_PLAY_SESSIONS and FORGET_PLAY_SESSIONS", () => {
  type GetPlaySessionsHandler = (event: IpcMainInvokeEvent, installationId: unknown) => Promise<PlaySessionsReadResult>
  type ForgetPlaySessionsHandler = (event: IpcMainInvokeEvent, installationId: unknown) => Promise<{ ok: boolean }>

  function getHandler(): GetPlaySessionsHandler {
    return getIpcHandler<GetPlaySessionsHandler>(IPC_CHANNELS.GAME_MANAGER.GET_PLAY_SESSIONS)
  }

  function forgetHandler(): ForgetPlaySessionsHandler {
    return getIpcHandler<ForgetPlaySessionsHandler>(IPC_CHANNELS.GAME_MANAGER.FORGET_PLAY_SESSIONS)
  }

  function writeSessionsFile(installationId: string, document: unknown): void {
    mkdirSync(join(userDataFolder, "Sessions"), { recursive: true })
    writeFileSync(join(userDataFolder, "Sessions", `${installationId}.json`), JSON.stringify(document), "utf-8")
  }

  const ONE_SESSION = { id: "abc", startedAt: 0, endedAt: 1_000, intervalMs: 5_000, partial: false, samples: [{ t: 0, rssBytes: 1_024 }] }

  it("throws Unauthorized IPC sender for an untrusted caller on both channels", async () => {
    await assert.rejects(() => getHandler()(createUntrustedEvent(), "main"), /Unauthorized IPC sender/)
    await assert.rejects(() => forgetHandler()(createUntrustedEvent(), "main"), /Unauthorized IPC sender/)
  })

  it("reads the sessions recorded for an Installation", async () => {
    writeConfig({})
    writeSessionsFile("main", { format: 1, sessions: [ONE_SESSION] })

    assert.deepEqual(await getHandler()(await createTrustedEvent(), "main"), { ok: true, sessions: [ONE_SESSION] })
  })

  it("refuses an id that is not one the config could have written, on both channels", async () => {
    writeConfig({})
    const event = await createTrustedEvent()

    assert.deepEqual(await getHandler()(event, "../../etc/passwd"), { ok: false, reason: "refused" })
    assert.deepEqual(await forgetHandler()(event, "../../etc/passwd"), { ok: false })
  })

  it("clears the file the sessions were in", async () => {
    writeConfig({})
    writeSessionsFile("main", { format: 1, sessions: [ONE_SESSION] })

    assert.deepEqual(await forgetHandler()(await createTrustedEvent(), "main"), { ok: true })
    assert.equal(existsSync(join(userDataFolder, "Sessions", "main.json")), false)
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

  // The probe's own spawn has the same throw-instead-of-emit gap EXECUTE_GAME's
  // does, and reaching it needs a candidate that gets past assertExecutable, so
  // this one is a real file rather than a directory.
  it("reports not found when the probe's spawn throws instead of emitting an error", async () => {
    const folder = join(versionsFolder, "throwing-probe")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, GAME_EXECUTABLE), "not a real binary", { mode: 0o644 })
    writeConfig({ gameVersions: [{ version: "1.20.0", path: folder }] as unknown as ConfigType["gameVersions"] })

    spawnThrow.next = true
    const event = await createTrustedEvent()
    const result = await lookForAGameVersionHandler()(event, folder)

    assert.deepEqual(result, { exists: false })
    assert.equal(spawnThrow.next, false, "the throwing spawn is the one this test ran")
  })

  /**
   * The two tests below are the only ones here that let a probe run to
   * completion, so they are also the only place the widened result is checked
   * end to end: a shell script standing in for the game binary prints the
   * transcript, the real probe reads it, and the boundary check decides what
   * crosses. The script lives in this run's own temporary folder, never beside
   * a real install.
   */
  it.skipIf(process.platform !== "linux")("carries the build variant across when the probe names the fork", async () => {
    const folder = join(versionsFolder, "optimum-build")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, GAME_EXECUTABLE), "#!/bin/sh\nprintf '%s\\n' '[Optimum] Optimum v0.3.14' '1.22.7 + Optimum v0.3.14' '1.22.7'\n")
    chmodSync(join(folder, GAME_EXECUTABLE), 0o755)
    writeConfig({ gameVersions: [{ version: "1.22.7", path: folder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await lookForAGameVersionHandler()(event, folder)

    assert.deepEqual(result, { exists: true, installedGameVersion: "1.22.7", variant: { name: "Optimum", version: "0.3.14" } })
  })

  it.skipIf(process.platform !== "linux")("sends no variant key at all for a build that names nothing", async () => {
    const folder = join(versionsFolder, "vanilla-build")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, GAME_EXECUTABLE), "#!/bin/sh\necho 1.22.7\n")
    chmodSync(join(folder, GAME_EXECUTABLE), 0o755)
    writeConfig({ gameVersions: [{ version: "1.22.7", path: folder }] as unknown as ConfigType["gameVersions"] })

    const event = await createTrustedEvent()
    const result = await lookForAGameVersionHandler()(event, folder)

    assert.deepEqual(result, { exists: true, installedGameVersion: "1.22.7" })
  })

  it("drops a variant the boundary check refuses before it reaches the renderer", async () => {
    const folder = join(versionsFolder, "spoofed-variant")
    mkdirSync(folder, { recursive: true })
    writeConfig({ gameVersions: [{ version: "1.22.7", path: folder }] as unknown as ConfigType["gameVersions"] })

    // Four dotted numbers: the version grammar reads three of them and semver
    // refuses the whole, which is what the check is there to catch.
    detectedVersion.next = { ok: true, version: "1.22.7", variant: { name: "Optimum", version: "0.3.14.7" } }

    const event = await createTrustedEvent()
    const result = await lookForAGameVersionHandler()(event, folder)

    assert.deepEqual(result, { exists: true, installedGameVersion: "1.22.7" }, "the game version still crosses; the variant does not")
    assert.equal(detectedVersion.next, null, "the queued result is the one this test ran")
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
