import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"
import type { ChildProcess } from "node:child_process"
import type { Worker } from "node:worker_threads"

import "./helpers/electronMock"
import { createTrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * Branch coverage for RUN_INSTALLER's win32-only arms in
 * src/ipc/handlers/pathsHandlers.ts, which tests/ipc/pathsHandlers.test.ts
 * deliberately leaves uncovered (see that file's own module comment): every
 * branch below this line only runs when `process.platform === "win32"`,
 * starting with the very first check in the handler.
 *
 * Isolation: this file stubs `process.platform` to "win32" for its own
 * process only. Vitest 4's default pool is "forks" (see vitest.config.ts,
 * which does not override `pool`), so each test FILE gets its own forked
 * Node process; a global mutation here cannot leak into pathsHandlers.test.ts
 * or any other file, which is what let the prior campaign skip this gap
 * instead of risking pathPolicy.ts's own platform-dependent comparisons
 * (`comparablePath` in validation.ts lower-cases on win32) for every test
 * sharing that file. The full suite staying green (see the PR description)
 * is the proof the stub stayed inside this process.
 *
 * The worker/spawn boundaries are mocked the same way pathsHandlers.test.ts
 * mocks them (worker `?modulePath` imports, `@src/ipc/workerManager`), plus
 * one more for this file specifically: `child_process`, since win32's
 * fallback `spawnInstaller` spawns a real process directly rather than going
 * through a tracked worker.
 */
vi.mock("@src/ipc/workers/compressWorker?modulePath", () => ({ default: "compressWorker-path" }))
vi.mock("@src/ipc/workers/extractWorker?modulePath", () => ({ default: "extractWorker-path" }))
vi.mock("@src/ipc/workers/innoExtractWorker?modulePath", () => ({ default: "innoExtractWorker-path" }))
vi.mock("@src/ipc/workers/changePermsWorker?modulePath", () => ({ default: "changePermsWorker-path" }))
vi.mock("@src/ipc/workers/downloadWorker?modulePath", () => ({ default: "downloadWorker-path" }))

vi.mock("@src/ipc/workerManager", () => ({
  createTrackedWorker: vi.fn(),
  disposeTrackedWorker: vi.fn()
}))

vi.mock("child_process", () => ({ spawn: vi.fn() }))

/** RUN_INSTALLER's own bound on the fallback spawn, mirrored from pathsHandlers.ts (not exported). */
const RUN_INSTALLER_TIMEOUT_MS = 15 * 60 * 1_000

/** Waits for the next `createTrackedWorker(...)` call and hands back a fake worker to drive, same as pathsHandlers.test.ts. */
async function nextTrackedWorker(): Promise<EventEmitter> {
  const { createTrackedWorker } = await import("@src/ipc/workerManager")
  return new Promise((resolvePromise) => {
    vi.mocked(createTrackedWorker).mockImplementationOnce(() => {
      const worker = new EventEmitter()
      resolvePromise(worker)
      return worker as unknown as Worker
    })
  })
}

/** Stands in for the `ChildProcess` spawnInstaller/attemptInstallerTreeKill drive with `.on`/`.pid`. */
class FakeInstallerProcess extends EventEmitter {
  constructor(public pid: number | undefined = 4242) {
    super()
  }
}

/** Waits for the next `spawn(...)` call (child_process) and hands back a fake process to drive. */
async function nextSpawnedProcess(): Promise<FakeInstallerProcess> {
  const { spawn } = await import("child_process")
  return new Promise((resolvePromise) => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      const proc = new FakeInstallerProcess()
      resolvePromise(proc)
      return proc as unknown as ChildProcess
    })
  })
}

let temporaryRoot: string
let managedFolder: string
let versionsFolder: string
let userDataFolder: string

function writeConfig(config: Partial<ConfigType>): void {
  const fullConfig = {
    schemaVersion: 2,
    lastUsedInstallation: null,
    defaultInstallationsFolder: managedFolder,
    defaultVersionsFolder: versionsFolder,
    backupsFolder: join(temporaryRoot, "Backups"),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler<R = Promise<unknown>> = (event: IpcMainInvokeEvent, ...args: any[]) => R

function handler<R = Promise<unknown>>(channel: string): Handler<R> {
  return getIpcHandler<Handler<R>>(channel)
}

/** Writes an installer file and records it as verified, the way DOWNLOAD_ON_PATH's caller normally would. */
async function writeVerifiedInstaller(installerPath: string, content = "fake-installer-bytes"): Promise<void> {
  writeFileSync(installerPath, content, "utf-8")
  const md5 = createHash("md5").update(content).digest("hex")
  const { recordVerifiedArtifact } = await import("@src/ipc/artifactVerification")
  await recordVerifiedArtifact(installerPath, new URL("https://cdn.vintagestory.at/x"), md5)
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")

beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
})

afterAll(() => {
  if (originalPlatformDescriptor) Object.defineProperty(process, "platform", originalPlatformDescriptor)
})

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "paths-handlers-win32-"))
  managedFolder = join(temporaryRoot, "Installations")
  versionsFolder = join(temporaryRoot, "Versions")
  userDataFolder = join(temporaryRoot, "userData")
  mkdirSync(userDataFolder, { recursive: true })
  mkdirSync(managedFolder, { recursive: true })
  mkdirSync(versionsFolder, { recursive: true })
  mkdirSync(join(temporaryRoot, "Backups"), { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  writeConfig({})

  // Both @src/ipc/workerManager and child_process are vi.mock()s, which stay
  // the same object across vi.resetModules(); clear their call history
  // explicitly rather than relying on afterEach's ordering (same reasoning
  // as pathsHandlers.test.ts's beforeEach).
  const { createTrackedWorker, disposeTrackedWorker } = await import("@src/ipc/workerManager")
  vi.mocked(createTrackedWorker).mockReset()
  vi.mocked(disposeTrackedWorker).mockReset()
  const { spawn } = await import("child_process")
  vi.mocked(spawn).mockReset()

  vi.resetModules()
  await import("@src/ipc/handlers/pathsHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("RUN_INSTALLER on win32: pre-flight branches", () => {
  it("returns installer-missing when the file disappears between assertManagedPath's check and RUN_INSTALLER's own", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    writeFileSync(installerPath, "", "utf-8")

    // assertManagedPath (not called with allowMissing) already required the file
    // to exist via a synchronous fse.existsSync, so the only way to reach this
    // handler's own async fse.pathExists check seeing it gone is to fake that
    // one specific call -- a real TOCTOU window, not a contrived setup. Scoped
    // to the installer path only: getConfig()'s own ensureConfig() also calls
    // fse.pathExists (on config.json), and a blanket mock would make it think
    // the just-written config is missing and fall back to an unmanaged default.
    const fse = (await import("fs-extra")).default
    const realPathExists = fse.pathExists.bind(fse)
    vi.spyOn(fse, "pathExists").mockImplementation(async (candidate: string) => (candidate === installerPath ? false : realPathExists(candidate)))

    const event = await createTrustedEvent()
    const result = await handler<Promise<InstallerRunResult>>(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "task-1", installerPath, versionsFolder, false)
    assert.deepEqual(result, { ok: false, reason: "installer-missing" })

    const { createTrackedWorker } = await import("@src/ipc/workerManager")
    assert.equal(vi.mocked(createTrackedWorker).mock.calls.length, 0)
    const { spawn } = await import("child_process")
    assert.equal(vi.mocked(spawn).mock.calls.length, 0)
  })

  it("rejects a non-.exe installer file", async () => {
    const installerPath = join(managedFolder, "setup.msi")
    writeFileSync(installerPath, "", "utf-8")

    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "task-1", installerPath, versionsFolder, false), /Invalid installer file/)
  })

  it("rejects an installer that was never downloaded and verified in this session", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    writeFileSync(installerPath, "unverified", "utf-8")

    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "task-1", installerPath, versionsFolder, false), /Installer was not downloaded and verified in this session/)
  })
})

describe("RUN_INSTALLER on win32: payload extraction", () => {
  it("resolves ok once the payload reader reports it extracted the game, without ever falling back to spawning the installer", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<InstallerRunResult>>(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "task-1", installerPath, versionsFolder, false)

    const worker = await workerPromise
    worker.emit("message", { type: "finished", verdict: "extracted", filesWritten: 12, bytesWritten: 4096 })

    assert.deepEqual(await resultPromise, { ok: true })

    const { createTrackedWorker } = await import("@src/ipc/workerManager")
    assert.equal(vi.mocked(createTrackedWorker).mock.calls.length, 1)
    const { spawn } = await import("child_process")
    assert.equal(vi.mocked(spawn).mock.calls.length, 0)
  })

  it("treats an extraction error as installer-failed, without falling back to spawning the installer", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<InstallerRunResult>>(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "task-2", installerPath, versionsFolder, false)

    const worker = await workerPromise
    worker.emit("error", new Error("disk read failed"))

    assert.deepEqual(await resultPromise, { ok: false, reason: "installer-failed" })

    const { spawn } = await import("child_process")
    assert.equal(vi.mocked(spawn).mock.calls.length, 0)
  })

  it("treats an unrecognized extraction verdict as installer-failed too", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<InstallerRunResult>>(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "task-3", installerPath, versionsFolder, false)

    const worker = await workerPromise
    worker.emit("message", { type: "finished", verdict: "not-a-real-verdict" })

    assert.deepEqual(await resultPromise, { ok: false, reason: "installer-failed" })
  })
})

describe("RUN_INSTALLER on win32: format-refused falls back to spawning the installer", () => {
  async function driveToFallbackSpawn(
    id: string,
    installerPath: string,
    outputPath: string,
    deleteInstaller: boolean,
    reason?: string
  ): Promise<{ resultPromise: Promise<InstallerRunResult>; proc: FakeInstallerProcess }> {
    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const spawnPromise = nextSpawnedProcess()
    const resultPromise = handler<Promise<InstallerRunResult>>(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, id, installerPath, outputPath, deleteInstaller)

    const worker = await workerPromise
    worker.emit("message", { type: "finished", verdict: "format-refused", reason })

    const proc = await spawnPromise
    return { resultPromise, proc }
  }

  it("spawns the installer with the expected arguments once the reader refuses the format", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    const { resultPromise, proc } = await driveToFallbackSpawn("task-1", installerPath, versionsFolder, false, "not an inno setup")
    proc.emit("close", 0)

    assert.deepEqual(await resultPromise, { ok: true })

    const { spawn } = await import("child_process")
    const call = vi.mocked(spawn).mock.calls[0]
    const command = call?.[0]
    const args = call?.[1] as string[] | undefined
    assert.equal(command, installerPath)
    assert.ok(args?.includes(`/DIR=${versionsFolder}`))
    assert.ok(args?.includes("/VERYSILENT"))
  })

  it("also falls back when the reader gives no usable reason string", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    const { resultPromise, proc } = await driveToFallbackSpawn("task-2", installerPath, versionsFolder, false)
    proc.emit("close", 0)

    assert.deepEqual(await resultPromise, { ok: true })
  })

  it("resolves installer-failed when the spawned installer errors before ever closing", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    const { resultPromise, proc } = await driveToFallbackSpawn("task-3", installerPath, versionsFolder, false, "not an inno setup")
    proc.emit("error", new Error("ENOENT"))

    assert.deepEqual(await resultPromise, { ok: false, reason: "installer-failed" })
  })

  it("resolves installer-failed when the spawned installer exits non-zero", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    const { resultPromise, proc } = await driveToFallbackSpawn("task-4", installerPath, versionsFolder, false, "not an inno setup")
    proc.emit("close", 1)

    assert.deepEqual(await resultPromise, { ok: false, reason: "installer-failed" })
  })

  it("resolves installer-failed when spawn() itself throws synchronously", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const { spawn } = await import("child_process")
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error("spawn EPERM")
    })
    const resultPromise = handler<Promise<InstallerRunResult>>(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "task-5", installerPath, versionsFolder, false)

    const worker = await workerPromise
    worker.emit("message", { type: "finished", verdict: "format-refused", reason: "not an inno setup" })

    assert.deepEqual(await resultPromise, { ok: false, reason: "installer-failed" })
  })

  it("deletes the installer file on a successful spawn install when deleteInstaller is set", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    const { resultPromise, proc } = await driveToFallbackSpawn("task-6", installerPath, versionsFolder, true, "not an inno setup")
    proc.emit("close", 0)
    assert.deepEqual(await resultPromise, { ok: true })

    await vi.waitFor(() => {
      if (existsSync(installerPath)) throw new Error("installer file was not removed yet")
    })
  })

  it("kills the installer's process tree and resolves installer-timed-out once the fallback bound elapses", async () => {
    const installerPath = join(managedFolder, "setup.exe")
    await writeVerifiedInstaller(installerPath)

    vi.useFakeTimers()
    try {
      const { resultPromise, proc } = await driveToFallbackSpawn("task-7", installerPath, versionsFolder, false, "not an inno setup")

      const killSpawnPromise = nextSpawnedProcess()
      await vi.advanceTimersByTimeAsync(RUN_INSTALLER_TIMEOUT_MS)
      const killProc = await killSpawnPromise

      assert.deepEqual(await resultPromise, { ok: false, reason: "installer-timed-out" })

      const { spawn } = await import("child_process")
      assert.equal(vi.mocked(spawn).mock.calls.length, 2)
      const killCall = vi.mocked(spawn).mock.calls[1]
      const killCommand = killCall?.[0]
      const killArgs = killCall?.[1] as string[] | undefined
      assert.equal(killCommand, "taskkill")
      assert.deepEqual(killArgs, ["/pid", String(proc.pid), "/T", "/F"])

      // Fire-and-forget by design (installerTimeoutOutcome.ts's own doc comment):
      // taskkill itself failing to launch only logs, since RUN_INSTALLER already
      // resolved. And finish()'s settled guard has to hold if the installer
      // process still manages to emit "close" after the timeout already won.
      assert.doesNotThrow(() => killProc.emit("error", new Error("taskkill: not found")))
      assert.doesNotThrow(() => proc.emit("close", 0))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("CHANGE_PERMS on win32", () => {
  it("returns false before any worker runs, since the permissions worker is Linux-only", async () => {
    const event = await createTrustedEvent()
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHANGE_PERMS)(event, [managedFolder], 0o755)
    assert.equal(result, false)

    const { createTrackedWorker } = await import("@src/ipc/workerManager")
    assert.equal(vi.mocked(createTrackedWorker).mock.calls.length, 0)
  })
})
