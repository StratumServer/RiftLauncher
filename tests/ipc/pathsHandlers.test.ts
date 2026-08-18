import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

// After "./helpers/electronMock": that side-effect import is what registers
// the vi.mock("electron", ...) factory, and it has to run before this file's
// own value import of "electron" resolves, or `shell` comes back undefined.
import { shell } from "electron"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * Branch coverage for src/ipc/handlers/pathsHandlers.ts, previously entirely
 * unimported by a test (0%): importing it needs `electron`'s `app`/`dialog`/
 * `shell` (covered by ./helpers/electronMock) AND every `?modulePath` worker
 * import to resolve to something other than the real worker module -- Vite
 * has no special handling for that query suffix outside electron-vite's own
 * build, so without a mock each import just runs the worker file for real,
 * which destructures `workerData` from `worker_threads` at module load and
 * throws immediately outside an actual worker thread.
 *
 * Scope: this file covers everything reachable WITHOUT driving a real
 * worker_thread or child_process. That includes `runTrackedWorker`'s own
 * message-handling logic (progress validation, "finished"/"error"/unknown
 * message shapes, the worker's own "error" event), which DOWNLOAD_ON_PATH/
 * EXTRACT_ON_PATH/COMPRESS_ON_PATH/CHANGE_PERMS all funnel through:
 * `@src/ipc/workerManager` is mocked so `createTrackedWorker` hands back a
 * plain `EventEmitter` a test drives directly instead of a real
 * `worker_threads.Worker`, which is what runTrackedWorker only ever calls
 * `.on`/`.once`/`.removeAllListeners` on anyway.
 *
 * Left uncovered: RUN_INSTALLER's payload-extraction and direct-spawn bodies
 * (`extractInstallerPayload`/`spawnInstaller`), which only run on
 * `process.platform === "win32"` -- stubbing that globally risks quietly
 * changing pathPolicy.ts's own platform-dependent comparisons for every other
 * test in this file, so RUN_INSTALLER here only covers the not-windows arm,
 * which is real, unstubbed behavior on the Linux host these tests run on.
 * See the PR description for that gap.
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

/**
 * Waits for the next `createTrackedWorker(...)` call (made by
 * `runTrackedWorker` once a channel's own validation/authorization has
 * passed) and hands back a fake worker the test can `.emit(...)` messages
 * and events on, standing in for the real `worker_threads.Worker`.
 */
async function nextTrackedWorker(): Promise<EventEmitter> {
  const { createTrackedWorker } = await import("@src/ipc/workerManager")
  return new Promise((resolvePromise) => {
    vi.mocked(createTrackedWorker).mockImplementationOnce(() => {
      const worker = new EventEmitter()
      resolvePromise(worker)
      return worker as unknown as import("worker_threads").Worker
    })
  })
}

let temporaryRoot: string
let managedFolder: string
let versionsFolder: string
let backupsFolder: string
let userDataFolder: string

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler<R = Promise<unknown>> = (event: IpcMainInvokeEvent, ...args: any[]) => R

/**
 * Reads back a captured `ipcMain.handle` callback for direct invocation.
 * Deliberately untyped on its arguments (only the return type `R` is
 * checked): every channel here takes a different argument shape, and this
 * file cares about exercising runtime validation with malformed input far
 * more often than it cares about the compiler enforcing well-formed input.
 * `R` defaults to `Promise<unknown>` since most channels are async; the
 * handful of synchronous ones (GET_CURRENT_USER_DATA_PATH, FORMAT_PATH's
 * untrusted-sender throw) are only ever asserted on with assert.throws/
 * assert.equal, which do not care that the declared return type says Promise.
 */
function handler<R = Promise<unknown>>(channel: string): Handler<R> {
  return getIpcHandler<Handler<R>>(channel)
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "paths-handlers-"))
  managedFolder = join(temporaryRoot, "Installations")
  versionsFolder = join(temporaryRoot, "Versions")
  backupsFolder = join(temporaryRoot, "Backups")
  userDataFolder = join(temporaryRoot, "userData")
  mkdirSync(userDataFolder, { recursive: true })
  mkdirSync(managedFolder, { recursive: true })
  mkdirSync(versionsFolder, { recursive: true })
  mkdirSync(backupsFolder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  writeConfig({})

  // @src/ipc/workerManager is a vi.mock, which -- like the electron mock --
  // stays the same object across vi.resetModules(); clear its call history
  // explicitly rather than relying on afterEach's ordering.
  const { createTrackedWorker, disposeTrackedWorker } = await import("@src/ipc/workerManager")
  vi.mocked(createTrackedWorker).mockReset()
  vi.mocked(disposeTrackedWorker).mockReset()

  vi.resetModules()
  await import("@src/ipc/handlers/pathsHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("GET_CURRENT_USER_DATA_PATH", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    assert.throws(() => handler(IPC_CHANNELS.PATHS_MANAGER.GET_CURRENT_USER_DATA_PATH)(createUntrustedEvent()), /Unauthorized IPC sender/)
  })

  it("returns the userData path for a trusted caller", async () => {
    const event = await createTrustedEvent()
    assert.equal(handler(IPC_CHANNELS.PATHS_MANAGER.GET_CURRENT_USER_DATA_PATH)(event), userDataFolder)
  })
})

describe("FORMAT_PATH: assertion throws", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    assert.throws(() => handler(IPC_CHANNELS.PATHS_MANAGER.FORMAT_PATH)(createUntrustedEvent(), ["a"]), /Unauthorized IPC sender/)
  })

  it("throws on an empty parts array", async () => {
    const event = await createTrustedEvent()
    assert.throws(() => handler<string>(IPC_CHANNELS.PATHS_MANAGER.FORMAT_PATH)(event, []), /Invalid path parts/)
  })

  it("throws on more than 32 parts", async () => {
    const event = await createTrustedEvent()
    assert.throws(() => handler<string>(IPC_CHANNELS.PATHS_MANAGER.FORMAT_PATH)(event, Array(33).fill("a")), /Invalid path parts/)
  })

  it("throws when a part is exactly '.' or '..'", async () => {
    const event = await createTrustedEvent()
    assert.throws(() => handler<string>(IPC_CHANNELS.PATHS_MANAGER.FORMAT_PATH)(event, ["ok", ".."]), /Invalid path part/)
  })

  it("joins valid parts", async () => {
    const event = await createTrustedEvent()
    assert.equal(handler<string>(IPC_CHANNELS.PATHS_MANAGER.FORMAT_PATH)(event, ["a", "b"]), join("a", "b"))
  })
})

describe("REMOVE_FILE_FROM_PATH", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    assert.throws(() => handler<string>(IPC_CHANNELS.PATHS_MANAGER.REMOVE_FILE_FROM_PATH)(createUntrustedEvent(), join(temporaryRoot, "file.txt")), /Unauthorized IPC sender/)
  })

  it("throws when the path fails validation", async () => {
    const event = await createTrustedEvent()
    assert.throws(() => handler<string>(IPC_CHANNELS.PATHS_MANAGER.REMOVE_FILE_FROM_PATH)(event, ""), /Invalid path/)
  })

  it("returns the parent of a file in the root directory", async () => {
    const event = await createTrustedEvent()
    const filePath = join(temporaryRoot, "file.txt")
    assert.equal(handler<string>(IPC_CHANNELS.PATHS_MANAGER.REMOVE_FILE_FROM_PATH)(event, filePath), temporaryRoot)
  })

  it("returns the parent of a file in a nested directory", async () => {
    const event = await createTrustedEvent()
    const filePath = join(temporaryRoot, "nested", "file.txt")
    assert.equal(handler<string>(IPC_CHANNELS.PATHS_MANAGER.REMOVE_FILE_FROM_PATH)(event, filePath), join(temporaryRoot, "nested"))
  })
})

describe("DOWNLOAD_ON_PATH / EXTRACT_ON_PATH / RUN_INSTALLER / COMPRESS_ON_PATH: the task-id assertion throws before any worker runs", () => {
  it("DOWNLOAD_ON_PATH rejects an unsafe task id", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "bad id!", "https://cdn.vintagestory.at/x", managedFolder, "x.zip"), /Invalid task id/)
  })

  it("DOWNLOAD_ON_PATH rejects a disallowed download URL", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-1", "https://example.com/x", managedFolder, "x.zip"), /URL is not allowed/)
  })

  it("DOWNLOAD_ON_PATH rejects an unsafe file name", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-1", "https://cdn.vintagestory.at/x", managedFolder, "../escape.zip"), /Invalid file name/)
  })

  it("EXTRACT_ON_PATH rejects an unsafe task id", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "bad id!", managedFolder, managedFolder, false), /Invalid task id/)
  })

  it("RUN_INSTALLER rejects an unsafe task id", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "bad id!", managedFolder, managedFolder, false), /Invalid task id/)
  })

  it("COMPRESS_ON_PATH rejects an unsafe task id", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.COMPRESS_ON_PATH)(event, "bad id!", managedFolder, managedFolder, "out.zip"), /Invalid task id/)
  })
})

describe("CHANGE_PERMS: assertion throws", () => {
  it("throws on an empty paths array", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.CHANGE_PERMS)(event, [], 0o644), /Invalid permissions paths/)
  })

  it("throws on more than 128 paths", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.CHANGE_PERMS)(event, Array(129).fill(managedFolder), 0o644), /Invalid permissions paths/)
  })
})

describe("DELETE_PATH", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.DELETE_PATH)(createUntrustedEvent(), managedFolder), /Unauthorized IPC sender/)
  })

  it("returns false for a path nothing authorizes", async () => {
    const event = await createTrustedEvent()
    const outsideFolder = join(temporaryRoot, "unmanaged")
    mkdirSync(outsideFolder, { recursive: true })

    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.DELETE_PATH)(event, outsideFolder)
    assert.equal(result, false)
  })

  it("returns false for a protected path (the launcher's own configured folder)", async () => {
    const event = await createTrustedEvent()
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.DELETE_PATH)(event, managedFolder)
    assert.equal(result, false)
  })

  it("deletes an authorized, unprotected path and returns true", async () => {
    const installation = join(managedFolder, "Main")
    mkdirSync(installation, { recursive: true })
    writeConfig({ installations: [{ id: "a", name: "A", path: installation, backups: [] }] as unknown as ConfigType["installations"] })

    const event = await createTrustedEvent()
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.DELETE_PATH)(event, installation)
    assert.equal(result, true)

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(installation), false)
  })
})

describe("MOVE_PATH", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.MOVE_PATH)(createUntrustedEvent(), managedFolder, versionsFolder), /Unauthorized IPC sender/)
  })

  it("returns false when the source path nothing authorizes", async () => {
    const event = await createTrustedEvent()
    const outsideFolder = join(temporaryRoot, "unmanaged")
    mkdirSync(outsideFolder, { recursive: true })

    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.MOVE_PATH)(event, outsideFolder, join(managedFolder, "New"))
    assert.equal(result, false)
  })

  it("returns false when source and destination are the same path", async () => {
    const installation = join(managedFolder, "Main")
    mkdirSync(installation, { recursive: true })
    writeConfig({ installations: [{ id: "a", name: "A", path: installation, backups: [] }] as unknown as ConfigType["installations"] })

    const event = await createTrustedEvent()
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.MOVE_PATH)(event, installation, installation)
    assert.equal(result, false)
  })

  it("returns false when the destination already exists", async () => {
    const installation = join(managedFolder, "Main")
    const otherInstallation = join(managedFolder, "Other")
    mkdirSync(installation, { recursive: true })
    mkdirSync(otherInstallation, { recursive: true })
    writeConfig({
      installations: [
        { id: "a", name: "A", path: installation, backups: [] },
        { id: "b", name: "B", path: otherInstallation, backups: [] }
      ] as unknown as ConfigType["installations"]
    })

    const event = await createTrustedEvent()
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.MOVE_PATH)(event, installation, otherInstallation)
    assert.equal(result, false)
  })

  it("moves an authorized source onto an authorized, not-yet-existing destination", async () => {
    const installation = join(managedFolder, "Main")
    mkdirSync(installation, { recursive: true })
    writeConfig({ installations: [{ id: "a", name: "A", path: installation, backups: [] }] as unknown as ConfigType["installations"] })

    const destination = join(managedFolder, "Renamed")
    const event = await createTrustedEvent()
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.MOVE_PATH)(event, installation, destination)
    assert.equal(result, true)

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(destination), true)
    assert.equal(existsSync(installation), false)
  })
})

describe("CHECK_PATH_EMPTY / CHECK_PATH_EXISTS / ENSURE_PATH_EXISTS", () => {
  it("CHECK_PATH_EMPTY reports true for a path that does not exist", async () => {
    const event = await createTrustedEvent()
    const missing = join(managedFolder, "missing")
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EMPTY)(event, missing)
    assert.equal(result, true)
  })

  it("CHECK_PATH_EMPTY reports false for a non-empty directory", async () => {
    writeFileSync(join(managedFolder, "file.txt"), "x", "utf-8")
    const event = await createTrustedEvent()
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EMPTY)(event, managedFolder)
    assert.equal(result, false)
  })

  it("CHECK_PATH_EXISTS reports whether the path exists", async () => {
    const event = await createTrustedEvent()
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EXISTS)(event, managedFolder), true)
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EXISTS)(event, join(managedFolder, "missing")), false)
  })

  it("ENSURE_PATH_EXISTS creates an authorized missing folder and returns true", async () => {
    const event = await createTrustedEvent()
    const target = join(managedFolder, "NewFolder")
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.ENSURE_PATH_EXISTS)(event, target)
    assert.equal(result, true)

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(target), true)
  })

  it("ENSURE_PATH_EXISTS returns false for a path nothing authorizes", async () => {
    const event = await createTrustedEvent()
    const outside = join(temporaryRoot, "unmanaged", "NewFolder")
    const result = await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.ENSURE_PATH_EXISTS)(event, outside)
    assert.equal(result, false)
  })
})

describe("OPEN_PATH_ON_FILE_EXPLORER", () => {
  it("shows an authorized path in the file explorer", async () => {
    const event = await createTrustedEvent()
    await handler(IPC_CHANNELS.PATHS_MANAGER.OPEN_PATH_ON_FILE_EXPLORER)(event, managedFolder)
    expect_calledWith(managedFolder)
  })

  function expect_calledWith(pathValue: string): void {
    assert.equal(vi.mocked(shell.showItemInFolder).mock.calls.at(-1)?.[0], pathValue)
  }
})

describe("COPY_TO_ICONS", () => {
  it("returns status: false for a non-png source file", async () => {
    const sourceFile = join(managedFolder, "icon.txt")
    writeFileSync(sourceFile, "not a png", "utf-8")

    const event = await createTrustedEvent()
    const result = await handler<Promise<{ status: boolean }>>(IPC_CHANNELS.PATHS_MANAGER.COPY_TO_ICONS)(event, sourceFile, "my-icon")
    assert.deepEqual(result, { status: false })
  })

  it("returns status: false when a symlink already occupies the destination", async () => {
    const sourceFile = join(managedFolder, "icon.png")
    writeFileSync(sourceFile, "fake-png-bytes", "utf-8")

    const iconsDirectory = join(userDataFolder, "Icons")
    mkdirSync(iconsDirectory, { recursive: true })
    const decoyTarget = join(iconsDirectory, "decoy-real-file.png")
    writeFileSync(decoyTarget, "decoy", "utf-8")
    // The destination COPY_TO_ICONS would write to is Icons/<name>.png; a
    // symlink already sitting there (even pointing at a real file) is what
    // the isSymbolicLink() check exists to refuse.
    symlinkSync(decoyTarget, join(iconsDirectory, "my-icon.png"))

    const event = await createTrustedEvent()
    const result = await handler<Promise<{ status: boolean }>>(IPC_CHANNELS.PATHS_MANAGER.COPY_TO_ICONS)(event, sourceFile, "my-icon")
    assert.deepEqual(result, { status: false })
  })

  it("copies an authorized png source into the Icons folder", async () => {
    const sourceFile = join(managedFolder, "icon.png")
    writeFileSync(sourceFile, "fake-png-bytes", "utf-8")

    const event = await createTrustedEvent()
    const result = await handler<Promise<{ status: boolean; file?: string }>>(IPC_CHANNELS.PATHS_MANAGER.COPY_TO_ICONS)(event, sourceFile, "my-icon")
    assert.deepEqual(result, { status: true, file: "my-icon.png" })

    const { existsSync, readFileSync } = await import("node:fs")
    const destination = join(userDataFolder, "Icons", "my-icon.png")
    assert.equal(existsSync(destination), true)
    assert.equal(readFileSync(destination, "utf-8"), "fake-png-bytes")
  })
})

describe("EXTRACT_ON_PATH: runTrackedWorker via a fake worker", () => {
  it("throws before any worker starts when the archive and output paths are the same", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)

    const event = await createTrustedEvent()
    await assert.rejects(() => handler(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-1", archivePath, archivePath, false), /Archive and output paths must differ/)
  })

  it("resolves true once the worker reports progress and then finishes", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-1", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("message", { type: "progress", progress: 50 })
    worker.emit("message", { type: "finished" })

    assert.equal(await resultPromise, true)

    const { disposeTrackedWorker } = await import("@src/ipc/workerManager")
    assert.equal(vi.mocked(disposeTrackedWorker).mock.calls.length, 1)
  })

  it("rejects when the worker emits an 'error' event", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-2")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-2", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("error", new Error("worker crashed"))

    await assert.rejects(() => resultPromise, /worker crashed/)
  })

  it("rejects on a worker message with no recognizable type", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-3")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-3", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("message", { type: "not-a-real-type" })

    await assert.rejects(() => resultPromise, /returned an unknown worker message/)
  })

  it("rejects when the worker exits before ever settling", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-4")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-4", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("exit", 1)

    await assert.rejects(() => resultPromise, /worker exited with code 1/)
  })

  it("rejects a worker message that is not even a record", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-5")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-5", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("message", "just a string, not a record")

    await assert.rejects(() => resultPromise, /returned an invalid worker message/)
  })

  it("rejects a progress message with a nonsensical progress value", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-6")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-6", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("message", { type: "progress", progress: 150 })

    await assert.rejects(() => resultPromise, /returned invalid progress/)
  })

  it("ignores a progress update that goes backwards, then still resolves on finish", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-7")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-7", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("message", { type: "progress", progress: 50 })
    worker.emit("message", { type: "progress", progress: 30 }) // ignored: it went backwards
    worker.emit("message", { type: "finished" })

    assert.equal(await resultPromise, true)
  })

  it("rejects on an explicit 'error' type message, using its own message string", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-8")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-8", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("message", { type: "error", message: "disk is full" })

    await assert.rejects(() => resultPromise, /disk is full/)
  })

  it("rejects on an explicit 'error' type message with no usable message string, falling back to a generic reason", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-9")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-9", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("message", { type: "error" })

    await assert.rejects(() => resultPromise, /EXTRACT_ON_PATH failed/)
  })
})

describe("COMPRESS_ON_PATH: runTrackedWorker via a fake worker", () => {
  it("resolves true once the worker finishes", async () => {
    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.COMPRESS_ON_PATH)(event, "task-1", managedFolder, versionsFolder, "archive.zip", 4)

    const worker = await workerPromise
    worker.emit("message", { type: "finished" })

    assert.equal(await resultPromise, true)
  })
})

describe("CHANGE_PERMS: runTrackedWorker via a fake worker", () => {
  it("resolves true once the worker finishes", async () => {
    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHANGE_PERMS)(event, [managedFolder], 0o755)

    const worker = await workerPromise
    worker.emit("message", { type: "finished" })

    assert.equal(await resultPromise, true)
  })
})

describe("DOWNLOAD_ON_PATH: runTrackedWorker via a fake worker", () => {
  // A moddb download URL, not cdn.vintagestory.at: getTrustedDownloadHash
  // short-circuits to `undefined` for any other host without making a
  // network request, so recordVerifiedArtifact (and the manifest fetch behind
  // it) never comes into play here.
  const DOWNLOAD_URL = "https://moddbcdn.vintagestory.at/some-mod-1.0.0.zip"

  it("resolves the downloaded path once the worker finishes", async () => {
    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-1", DOWNLOAD_URL, versionsFolder, "some-mod.zip")

    const worker = await workerPromise
    const downloadedPath = join(versionsFolder, "some-mod.zip")
    worker.emit("message", { type: "finished", path: downloadedPath })

    assert.equal(await resultPromise, downloadedPath)
  })

  it("rejects when the worker's finished message carries no usable path", async () => {
    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-2", DOWNLOAD_URL, versionsFolder, "some-mod.zip")

    const worker = await workerPromise
    worker.emit("message", { type: "finished" })

    await assert.rejects(() => resultPromise, /Download returned an invalid path/)
  })
})

describe("RUN_INSTALLER", () => {
  it("resolves not-windows on a non-Windows host, before any worker or spawn", async () => {
    // assertManagedPath for the installer path requires it to exist (it is
    // not called with { allowMissing: true }), so the not-windows check --
    // which comes after it -- still needs a real file to reach.
    const installerPath = join(managedFolder, "setup.exe")
    writeFileSync(installerPath, "", "utf-8")

    const event = await createTrustedEvent()
    const result = await handler<Promise<InstallerRunResult>>(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "task-1", installerPath, versionsFolder, false)
    assert.deepEqual(result, { ok: false, reason: "not-windows" })

    const { createTrackedWorker } = await import("@src/ipc/workerManager")
    assert.equal(vi.mocked(createTrackedWorker).mock.calls.length, 0)
  })
})
