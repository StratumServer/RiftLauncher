import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { clearAppEventListeners, createTrustedEvent, createUntrustedEvent, emitAppEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

// After "./helpers/electronMock": that side-effect import is what registers
// the vi.mock("electron", ...) factory, and it has to run before this file's
// own value import of "electron" resolves, or `shell` comes back undefined.
import { shell } from "electron"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { MAX_CUSTOM_ICON_BYTES } from "@src/ipc/validation"

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
 * `@src/ipc/workerManager` is mocked so `acquireWorker` hands back a lease
 * wrapping a plain `EventEmitter` a test drives directly instead of a real
 * `worker_threads.Worker`, which is what runTrackedWorker only ever calls
 * `.on`/`.off` on anyway. The pool's own reuse/discard bookkeeping lives in
 * workerPool.test.ts; this file only checks that runTrackedWorker asks for
 * the right one at each settle path (see the `release` assertions below).
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
  acquireWorker: vi.fn()
}))

let nextLeaseToken = 1

/**
 * Waits for the next `acquireWorker(...)` call (made by `runTrackedWorker` once a
 * channel's own validation/authorization has passed) and hands back a fake worker the
 * test can `.emit(...)` messages and events on, standing in for the real
 * `worker_threads.Worker`. The returned object also carries `release`, the lease's own
 * mock, for tests that check whether a worker was handed back for reuse or discarded.
 */
async function nextTrackedWorker(): Promise<EventEmitter & { release: ReturnType<typeof vi.fn>; dispatch: ReturnType<typeof vi.fn> }> {
  const { acquireWorker } = await import("@src/ipc/workerManager")
  const token = nextLeaseToken++
  return new Promise((resolvePromise) => {
    vi.mocked(acquireWorker).mockImplementationOnce(() => {
      const release = vi.fn()
      // Carried on the worker too, so a test can read the payload the handler
      // built (what it decided, not just that it started something).
      const dispatch = vi.fn()
      const worker = Object.assign(new EventEmitter(), { release, dispatch })
      resolvePromise(worker)
      return {
        worker: worker as unknown as import("worker_threads").Worker,
        token,
        dispatch,
        release
      }
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
  // Cleared before pathsHandlers.ts's fresh import below registers its own before-quit
  // listener: without this, a listener from a previous test's now-shut-down limiters would
  // still be sitting in the map and fire again on this test's emitAppEvent call.
  clearAppEventListeners()

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
  const { acquireWorker } = await import("@src/ipc/workerManager")
  vi.mocked(acquireWorker).mockReset()

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

// CHANGE_PERMS returns false on anything that is not Linux before it looks at
// its arguments at all (pathsHandlers.ts: `if (os.platform() !== "linux") return
// false`), since POSIX mode bits are the only thing it has to apply. On Windows
// nothing here can throw, so these two cover the Linux arm only.
describe.skipIf(process.platform === "win32")("CHANGE_PERMS: assertion throws", () => {
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

  // AddInstallation's folder field is free text, and its guard turns a false
  // here into "we could not make that folder" and stops the add. Answering true
  // for a regular file would put an installation entry on it, which is the
  // dangling entry the guard exists to prevent, and that path then feeds the
  // launch --dataPath, the backup compression and the mod scan.
  it("ENSURE_PATH_EXISTS returns false for an authorized path that exists as a regular file", async () => {
    const event = await createTrustedEvent()
    const file = join(managedFolder, "notes.txt")
    writeFileSync(file, "x", "utf-8")

    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.ENSURE_PATH_EXISTS)(event, file), false)

    const { readFileSync } = await import("node:fs")
    assert.equal(readFileSync(file, "utf-8"), "x")
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

/**
 * The reported shape in #237, driven through the handlers the mod screen calls.
 *
 * A profile whose Mods folder is itself a link at a Mods folder kept elsewhere.
 * The read-only channels answer for it now; everything that writes still meets
 * the path policy's symlink walk, which is what stops a link from being a way
 * around the grant. Windows is skipped because making a symlink there needs
 * Developer Mode or elevation the CI runners do not have (#267 tracks it), and
 * the handler code is the same on every platform.
 */
describe.skipIf(process.platform === "win32")("a Mods folder the user symlinked in", () => {
  let installation: string
  let realMods: string
  let linkedMods: string

  beforeEach(() => {
    installation = join(managedFolder, "Main")
    mkdirSync(installation, { recursive: true })
    writeConfig({ installations: [{ id: "a", name: "A", path: installation, backups: [] }] as unknown as ConfigType["installations"] })

    realMods = join(temporaryRoot, "VintagestoryData", "Mods")
    mkdirSync(realMods, { recursive: true })
    writeFileSync(join(realMods, "amod.zip"), "x", "utf-8")

    linkedMods = join(installation, "Mods")
    symlinkSync(realMods, linkedMods, "dir")
  })

  it("CHECK_PATH_EXISTS reports the linked folder as present", async () => {
    const event = await createTrustedEvent()
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EXISTS)(event, linkedMods), true)
  })

  // The exact symptom from the report: the folder button called this one, got
  // false back from the swallowed policy throw, and told the user their folder
  // did not exist. The link has to survive too, not be replaced by a real
  // directory on the way through ensureDir.
  it("ENSURE_PATH_EXISTS reports the linked folder as present and leaves the link alone", async () => {
    const event = await createTrustedEvent()
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.ENSURE_PATH_EXISTS)(event, linkedMods), true)

    const { lstatSync } = await import("node:fs")
    assert.equal(lstatSync(linkedMods).isSymbolicLink(), true)
  })

  // The settings and install-folder pickers call this one and none of them
  // catches. A throw took the whole pick down with it, so the chosen folder was
  // never applied and the user got neither the warning nor an error.
  it("CHECK_PATH_EMPTY answers for the linked folder instead of rejecting", async () => {
    const event = await createTrustedEvent()
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EMPTY)(event, linkedMods), false)

    const emptyReal = join(temporaryRoot, "VintagestoryData", "Empty")
    mkdirSync(emptyReal, { recursive: true })
    const emptyLink = join(installation, "EmptyLink")
    symlinkSync(emptyReal, emptyLink, "dir")
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EMPTY)(event, emptyLink), true)
  })

  // The read grade reaches wider than the Mods folder: an installation whose
  // own folder is a link answers the pre-flight the backup and launch flows run.
  it("CHECK_PATH_EXISTS reports an installation folder that is itself a link", async () => {
    const realInstallation = join(temporaryRoot, "Elsewhere", "Main")
    mkdirSync(realInstallation, { recursive: true })
    const linkedInstallation = join(managedFolder, "Linked")
    symlinkSync(realInstallation, linkedInstallation, "dir")
    writeConfig({ installations: [{ id: "b", name: "B", path: linkedInstallation, backups: [] }] as unknown as ConfigType["installations"] })

    const event = await createTrustedEvent()
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EXISTS)(event, linkedInstallation), true)
  })

  it("OPEN_PATH_ON_FILE_EXPLORER shows the linked folder", async () => {
    const event = await createTrustedEvent()
    await handler(IPC_CHANNELS.PATHS_MANAGER.OPEN_PATH_ON_FILE_EXPLORER)(event, linkedMods)
    assert.equal(vi.mocked(shell.showItemInFolder).mock.calls.at(-1)?.[0], linkedMods)
  })

  // Reporting is a read, creating is not. Dropping the second, strict
  // assertManagedPath in ENSURE_PATH_EXISTS turns this row green the wrong way:
  // the folder would appear inside the link target, outside the grant.
  it("ENSURE_PATH_EXISTS refuses to create a folder through the link", async () => {
    const event = await createTrustedEvent()
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.ENSURE_PATH_EXISTS)(event, join(linkedMods, "New")), false)

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(join(realMods, "New")), false)
  })

  it("DELETE_PATH still refuses a mod reached through the link, and leaves it on disk", async () => {
    const event = await createTrustedEvent()
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.DELETE_PATH)(event, join(linkedMods, "amod.zip")), false)

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(join(realMods, "amod.zip")), true)
  })

  it("DELETE_PATH refuses a link inside the installation that escapes into a system folder", async () => {
    symlinkSync("/etc", join(installation, "escape"), "dir")

    const event = await createTrustedEvent()
    assert.equal(await handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.DELETE_PATH)(event, join(installation, "escape", "hosts")), false)

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync("/etc/hosts"), true)
  })

  it("DOWNLOAD_ON_PATH refuses the linked folder as an output path, so installing a mod into it is not widened here", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(
      () => handler(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-1", "https://moddbcdn.vintagestory.at/some-mod-1.0.0.zip", linkedMods, "a.zip"),
      /Symbolic links are not allowed/
    )
  })
})

describe("COPY_TO_ICONS", () => {
  /** Real PNG bytes: the eight-byte signature, then a payload no decoder is asked to read. */
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture-icon-not-a-real-png")])

  /** Runs the channel and hands back its verdict plus whatever it wrote at debug. */
  async function copyIcon(sourceFile: string): Promise<{ result: unknown; debugLines: string[] }> {
    const Logger = (await import("electron-log")).default
    const debug = vi.spyOn(Logger, "debug").mockImplementation(() => undefined)

    try {
      const event = await createTrustedEvent()
      const result = await handler(IPC_CHANNELS.PATHS_MANAGER.COPY_TO_ICONS)(event, sourceFile, "my-icon")
      return { result, debugLines: debug.mock.calls.map((call) => String(call[0])) }
    } finally {
      debug.mockRestore()
    }
  }

  /** Every refusal names itself to the caller and puts its cause in the log. */
  function assert_refused(outcome: { result: unknown; debugLines: string[] }, reason: string): void {
    assert.deepEqual(outcome.result, { status: false, reason })
    const refusalLines = outcome.debugLines.filter((line) => line.includes("[COPY_TO_ICONS] Refused an icon"))
    assert.equal(refusalLines.length, 1, `expected one refusal line at debug, got ${refusalLines.length}: ${outcome.debugLines.join(" / ")}`)
    assert.ok(refusalLines[0]?.includes(`(${reason})`), `refusal line does not name the reason: ${refusalLines[0]}`)
  }

  it("refuses a non-png source file as unsupported-format", async () => {
    const sourceFile = join(managedFolder, "icon.txt")
    writeFileSync(sourceFile, "not a png", "utf-8")

    assert_refused(await copyIcon(sourceFile), "unsupported-format")
  })

  it("refuses a source file with no extension at all as unsupported-format", async () => {
    const sourceFile = join(managedFolder, "icon")
    writeFileSync(sourceFile, "not a png", "utf-8")

    assert_refused(await copyIcon(sourceFile), "unsupported-format")
  })

  it("refuses a source file outside every managed folder as source-unavailable", async () => {
    const outsideFolder = join(temporaryRoot, "Elsewhere")
    mkdirSync(outsideFolder, { recursive: true })
    const sourceFile = join(outsideFolder, "icon.png")
    writeFileSync(sourceFile, "fake-png-bytes", "utf-8")

    assert_refused(await copyIcon(sourceFile), "source-unavailable")
  })

  it("refuses a source file that is not there as source-unavailable", async () => {
    assert_refused(await copyIcon(join(managedFolder, "gone.png")), "source-unavailable")
  })

  it("refuses a source reached through a symlinked folder as source-unavailable", async () => {
    const realFolder = join(temporaryRoot, "RealPictures")
    mkdirSync(realFolder, { recursive: true })
    writeFileSync(join(realFolder, "icon.png"), "fake-png-bytes", "utf-8")
    symlinkSync(realFolder, join(managedFolder, "Pictures"))

    assert_refused(await copyIcon(join(managedFolder, "Pictures", "icon.png")), "source-unavailable")
  })

  // Nothing is read from a source that is not a plain file. Deleting the
  // isFile() check in COPY_TO_ICONS fails this row and the FIFO one below.
  it("refuses a folder that happens to be named like a png as source-unavailable", async () => {
    const sourceFolder = join(managedFolder, "folder.png")
    mkdirSync(sourceFolder, { recursive: true })

    assert_refused(await copyIcon(sourceFolder), "source-unavailable")
  })

  it.skipIf(process.platform === "win32")("refuses a FIFO named like a png as source-unavailable", async () => {
    const fifo = join(managedFolder, "pipe.png")
    execFileSync("mkfifo", [fifo])

    assert_refused(await copyIcon(fifo), "source-unavailable")

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(join(userDataFolder, "Icons", "my-icon.png")), false)
  })

  // Two checks refuse this, and removing either one on its own leaves the row
  // green: the path policy's symlink walk gets there first, and the isFile()
  // check above catches it after, since lstat reports a symlink as not a file.
  // Only deleting both lets the link through.
  it.skipIf(process.platform === "win32")("refuses a symlink standing in for the picked png as source-unavailable", async () => {
    const target = join(managedFolder, "real.png")
    writeFileSync(target, PNG)
    symlinkSync(target, join(managedFolder, "link.png"))

    assert_refused(await copyIcon(join(managedFolder, "link.png")), "source-unavailable")

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(join(userDataFolder, "Icons", "my-icon.png")), false)
  })

  // The parity row for the background flow's ceiling: refused on the size lstat
  // reports, before a byte of it is read. Deleting the MAX_CUSTOM_ICON_BYTES
  // check fails here.
  it("refuses a png past the icon ceiling as too-large", async () => {
    const sourceFile = join(managedFolder, "icon.png")
    writeFileSync(sourceFile, Buffer.concat([PNG, Buffer.alloc(MAX_CUSTOM_ICON_BYTES)]))

    assert_refused(await copyIcon(sourceFile), "too-large")

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(join(userDataFolder, "Icons", "my-icon.png")), false)
  })

  // The parity row for the background flow's magic-byte gate (#211): the name
  // says .png, the bytes say otherwise, and nothing reaches the Icons folder.
  // Deleting the signature check in COPY_TO_ICONS fails here.
  it("refuses a file named .png whose bytes are not a PNG as unsupported-format", async () => {
    const sourceFile = join(managedFolder, "icon.png")
    writeFileSync(sourceFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]))

    assert_refused(await copyIcon(sourceFile), "unsupported-format")

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(join(userDataFolder, "Icons", "my-icon.png")), false)
  })

  it("refuses a .png too short to carry the whole signature as unsupported-format", async () => {
    const sourceFile = join(managedFolder, "icon.png")
    writeFileSync(sourceFile, PNG.subarray(0, 4))

    assert_refused(await copyIcon(sourceFile), "unsupported-format")
  })

  it("refuses as copy-failed when a symlink already occupies the destination", async () => {
    const sourceFile = join(managedFolder, "icon.png")
    writeFileSync(sourceFile, PNG)

    const iconsDirectory = join(userDataFolder, "Icons")
    mkdirSync(iconsDirectory, { recursive: true })
    const decoyTarget = join(iconsDirectory, "decoy-real-file.png")
    writeFileSync(decoyTarget, "decoy", "utf-8")
    // The destination COPY_TO_ICONS would write to is Icons/<name>.png; a
    // symlink already sitting there (even pointing at a real file) is what
    // the isSymbolicLink() check exists to refuse.
    symlinkSync(decoyTarget, join(iconsDirectory, "my-icon.png"))

    assert_refused(await copyIcon(sourceFile), "copy-failed")
  })

  it("copies an authorized png source into the Icons folder", async () => {
    const sourceFile = join(managedFolder, "icon.png")
    writeFileSync(sourceFile, PNG)

    const event = await createTrustedEvent()
    const result = await handler<Promise<{ status: boolean; file?: string }>>(IPC_CHANNELS.PATHS_MANAGER.COPY_TO_ICONS)(event, sourceFile, "my-icon")
    assert.deepEqual(result, { status: true, file: "my-icon.png" })

    const { existsSync, readFileSync } = await import("node:fs")
    const destination = join(userDataFolder, "Icons", "my-icon.png")
    assert.equal(existsSync(destination), true)
    assert.deepEqual(readFileSync(destination), PNG)
  })

  // The acceptance row for the extension gate: an icon carried over from
  // another launcher is as likely to be named ICON.PNG as icon.png, and every
  // other .png check in the flow (the `icons:` protocol, normalizeIcon) lower
  // cases before it compares. Re-tightening the gate to a case-sensitive
  // ".png" fails here.
  it("copies a source named with an upper case .PNG extension", async () => {
    const sourceFile = join(managedFolder, "ICON.PNG")
    writeFileSync(sourceFile, PNG)

    const event = await createTrustedEvent()
    const result = await handler<Promise<{ status: boolean; file?: string }>>(IPC_CHANNELS.PATHS_MANAGER.COPY_TO_ICONS)(event, sourceFile, "my-icon")
    assert.deepEqual(result, { status: true, file: "my-icon.png" })
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

    // A clean finish releases the worker for reuse, not a hard terminate: that is the
    // whole point of pooling it in the first place.
    assert.equal(worker.release.mock.calls.length, 1)
    assert.equal(worker.release.mock.calls[0]?.[0], "reuse")
  })

  it("forwards each progress percentage once, including one terminal 100", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "coalesced-progress")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-progress", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("message", { type: "progress", progress: 50 })
    worker.emit("message", { type: "progress", progress: 50 })
    worker.emit("message", { type: "progress", progress: 100 })
    worker.emit("message", { type: "progress", progress: 100 })
    worker.emit("message", { type: "finished" })

    assert.equal(await resultPromise, true)
    assert.deepEqual(
      vi.mocked(event.sender.send).mock.calls.map(([, message]) => message),
      [
        { id: "task-progress", progress: 0 },
        { id: "task-progress", progress: 50 },
        { id: "task-progress", progress: 100 }
      ]
    )
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
    // An uncaught exception in the worker leaves it in an unknown state: never reused.
    assert.equal(worker.release.mock.calls[0]?.[0], "discard")
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
    assert.equal(worker.release.mock.calls[0]?.[0], "discard")
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
    // The thread is gone; nothing left to reuse.
    assert.equal(worker.release.mock.calls[0]?.[0], "discard")
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
    // A reported task failure ran the worker's own error path and left it fit to reuse:
    // every logic module under src/ipc/workers/ cleans up its own temp state on failure.
    assert.equal(worker.release.mock.calls[0]?.[0], "reuse")
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

  it("discards, not reuses, a worker whose error message sets retire", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-10")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-10", archivePath, outputPath, false)

    const worker = await workerPromise
    // workerHost.ts posts this when a worker receives a task while already busy on
    // another one -- a state the worker itself is saying it should not serve again.
    worker.emit("message", { type: "error", message: "Worker received a task while busy", retire: true })

    await assert.rejects(() => resultPromise, /Worker received a task while busy/)
    assert.equal(worker.release.mock.calls[0]?.[0], "discard")
  })

  it("ignores a message tagged with another task's token, then still resolves on its own", async () => {
    const archivePath = join(managedFolder, "archive.zip")
    copyFileSync(resolvePath(__dirname, "../fixtures/valid-mod.zip"), archivePath)
    const outputPath = join(versionsFolder, "extracted-11")

    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-11", archivePath, outputPath, false)

    const worker = await workerPromise
    // A message stamped with a token this lease never had: exactly what a reused
    // worker's abandoned previous task would still be capable of posting.
    worker.emit("message", { type: "progress", token: -1, progress: 90 })
    worker.emit("message", { type: "finished" })

    assert.equal(await resultPromise, true)
    assert.deepEqual(
      vi.mocked(event.sender.send).mock.calls.map(([, message]) => message),
      [{ id: "task-11", progress: 0 }]
    )
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
    assert.deepEqual(
      vi.mocked(event.sender.send).mock.calls.map(([, message]) => message),
      [{ id: "task-1", progress: 0 }]
    )
  })
})

// Same Linux-only early return: on Windows the handler resolves false without
// ever starting a worker, so the fake worker this waits for never arrives.
describe.skipIf(process.platform === "win32")("CHANGE_PERMS: runTrackedWorker via a fake worker", () => {
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
    assert.deepEqual(
      vi.mocked(event.sender.send).mock.calls.map(([, message]) => message),
      [{ id: "task-1", progress: 0 }]
    )
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

describe("DOWNLOAD_ON_PATH: concurrency limit", () => {
  const DOWNLOAD_URL = "https://moddbcdn.vintagestory.at/some-mod-1.0.0.zip"

  it("caps concurrent downloads at 3 and starts a 4th only once a slot frees", async () => {
    const event = await createTrustedEvent()
    const { acquireWorker } = await import("@src/ipc/workerManager")

    // A local, synchronous stand-in for the shared nextTrackedWorker() helper above: that
    // one does `await import(...)` before registering its mockImplementationOnce, which is
    // invisible with one call in flight (every other test here) but races a handler that
    // reaches acquireWorker before that import's microtask settles once several calls
    // overlap, exactly what this test needs to fire at once.
    function queueNextWorker(): Promise<EventEmitter> {
      return new Promise((resolvePromise) => {
        vi.mocked(acquireWorker).mockImplementationOnce(() => {
          const worker = new EventEmitter()
          resolvePromise(worker)
          return {
            worker: worker as unknown as import("worker_threads").Worker,
            token: nextLeaseToken++,
            dispatch: vi.fn(),
            release: vi.fn()
          }
        })
      })
    }

    const worker1Promise = queueNextWorker()
    const result1 = handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-1", DOWNLOAD_URL, versionsFolder, "one.zip")
    const worker1 = await worker1Promise

    const worker2Promise = queueNextWorker()
    const result2 = handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-2", DOWNLOAD_URL, versionsFolder, "two.zip")
    const worker2 = await worker2Promise

    const worker3Promise = queueNextWorker()
    const result3 = handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-3", DOWNLOAD_URL, versionsFolder, "three.zip")
    const worker3 = await worker3Promise

    // 3 active downloads is the configured limit: a 4th call must stay queued,
    // never reaching acquireWorker, until one of the first 3 finishes.
    const callsBeforeFourth = vi.mocked(acquireWorker).mock.calls.length
    const result4 = handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-4", DOWNLOAD_URL, versionsFolder, "four.zip")
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    assert.equal(vi.mocked(acquireWorker).mock.calls.length, callsBeforeFourth)

    const worker4Promise = queueNextWorker()
    worker1.emit("message", { type: "finished", path: join(versionsFolder, "one.zip") })
    const worker4 = await worker4Promise

    worker2.emit("message", { type: "finished", path: join(versionsFolder, "two.zip") })
    worker3.emit("message", { type: "finished", path: join(versionsFolder, "three.zip") })
    worker4.emit("message", { type: "finished", path: join(versionsFolder, "four.zip") })

    assert.equal(await result1, join(versionsFolder, "one.zip"))
    assert.equal(await result2, join(versionsFolder, "two.zip"))
    assert.equal(await result3, join(versionsFolder, "three.zip"))
    assert.equal(await result4, join(versionsFolder, "four.zip"))
  })
})

describe("before-quit: the limiters stop admitting work", () => {
  it("DOWNLOAD_ON_PATH rejects a call still queued when before-quit fires, and never reaches acquireWorker for it", async () => {
    const event = await createTrustedEvent()
    const { acquireWorker } = await import("@src/ipc/workerManager")
    const DOWNLOAD_URL = "https://moddbcdn.vintagestory.at/some-mod-1.0.0.zip"

    function queueNextWorker(): Promise<EventEmitter> {
      return new Promise((resolvePromise) => {
        vi.mocked(acquireWorker).mockImplementationOnce(() => {
          const worker = new EventEmitter()
          resolvePromise(worker)
          return {
            worker: worker as unknown as import("worker_threads").Worker,
            token: nextLeaseToken++,
            dispatch: vi.fn(),
            release: vi.fn()
          }
        })
      })
    }

    // Fill the download limit (3) so the 4th call queues instead of starting.
    const worker1Promise = queueNextWorker()
    handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-1", DOWNLOAD_URL, versionsFolder, "one.zip")
    await worker1Promise
    const worker2Promise = queueNextWorker()
    handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-2", DOWNLOAD_URL, versionsFolder, "two.zip")
    await worker2Promise
    const worker3Promise = queueNextWorker()
    handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-3", DOWNLOAD_URL, versionsFolder, "three.zip")
    await worker3Promise

    const callsBeforeQueued = vi.mocked(acquireWorker).mock.calls.length
    const queuedResult = handler<Promise<string>>(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH)(event, "task-4", DOWNLOAD_URL, versionsFolder, "four.zip")
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    assert.equal(vi.mocked(acquireWorker).mock.calls.length, callsBeforeQueued)

    emitAppEvent("before-quit")
    await assert.rejects(queuedResult, /Cancelled because the app is quitting/)
    // Shutdown ran before the freed download slot (if any) could ever reach it.
    assert.equal(vi.mocked(acquireWorker).mock.calls.length, callsBeforeQueued)
  })

  it("COMPRESS_ON_PATH rejects a call arriving after before-quit, without ever calling acquireWorker", async () => {
    const event = await createTrustedEvent()
    const { acquireWorker } = await import("@src/ipc/workerManager")

    emitAppEvent("before-quit")

    const result = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.COMPRESS_ON_PATH)(event, "task-1", managedFolder, versionsFolder, "archive.zip", 4)
    await assert.rejects(result, /Cancelled because the app is quitting/)
    assert.equal(vi.mocked(acquireWorker).mock.calls.length, 0)
  })
})

describe("RUN_INSTALLER", () => {
  // This exercises the real, unstubbed process.platform !== "win32" branch
  // (see the file header): on an actual Windows host that branch can't fire,
  // so RUN_INSTALLER proceeds into the win32 arm this file doesn't cover.
  it.skipIf(process.platform === "win32")("resolves not-windows on a non-Windows host, before any worker or spawn", async () => {
    // assertManagedPath for the installer path requires it to exist (it is
    // not called with { allowMissing: true }), so the not-windows check --
    // which comes after it -- still needs a real file to reach.
    const installerPath = join(managedFolder, "setup.exe")
    writeFileSync(installerPath, "", "utf-8")

    const event = await createTrustedEvent()
    const result = await handler<Promise<InstallerRunResult>>(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER)(event, "task-1", installerPath, versionsFolder, false)
    assert.deepEqual(result, { ok: false, reason: "not-windows" })

    const { acquireWorker } = await import("@src/ipc/workerManager")
    assert.equal(vi.mocked(acquireWorker).mock.calls.length, 0)
  })
})

/**
 * Which pair of size ceilings an extraction runs under (#362).
 *
 * The decision has to be the main process's: a flag on the IPC call would let
 * the renderer ask for the loose limit for a mod archive it just downloaded,
 * which is the boundary the path policy exists to hold. So the handler works it
 * out from the config it already reads, and these read the answer off the
 * payload it hands the worker.
 */
describe("EXTRACT_ON_PATH: telling a backup apart from a downloaded archive", () => {
  /** Starts an extraction and returns the payload the handler dispatched to the worker. */
  async function dispatchedPayload(archivePath: string, outputPath: string): Promise<Record<string, unknown>> {
    const event = await createTrustedEvent()
    const workerPromise = nextTrackedWorker()
    const resultPromise = handler<Promise<boolean>>(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH)(event, "task-limits", archivePath, outputPath, false)

    const worker = await workerPromise
    worker.emit("message", { type: "finished" })
    await resultPromise

    return worker.dispatch.mock.calls[0]?.[0] as Record<string, unknown>
  }

  function writeArchive(folder: string, name: string): string {
    mkdirSync(folder, { recursive: true })
    const archivePath = join(folder, name)
    writeFileSync(archivePath, "not read by the handler")
    return archivePath
  }

  it("marks an archive the config records as a backup", async () => {
    const archivePath = writeArchive(join(backupsFolder, "Installations", "Survival"), "Survival_2026-09-04.tar.gz")
    writeConfig({
      installations: [{ id: "a", name: "A", path: join(managedFolder, "Survival"), backups: [{ id: "b1", date: 1, path: archivePath }] }] as unknown as ConfigType["installations"]
    })

    const payload = await dispatchedPayload(archivePath, join(managedFolder, "Survival"))

    assert.equal(payload.isBackupArchive, true)
  })

  it("does not mark an unrecorded archive that merely sits in the backups folder", async () => {
    // Sitting under the Backups folder is not what makes an archive a backup.
    // Nothing stops a player nesting their versions folder there, and the
    // download channel is granted that tree, so containment would be a way to
    // hand a downloaded archive the backup ceiling.
    const archivePath = writeArchive(join(backupsFolder, "Installations", "Survival"), "Survival_2026-09-04.tar.gz")
    writeConfig({ installations: [{ id: "a", name: "A", path: join(managedFolder, "Survival"), backups: [] }] as unknown as ConfigType["installations"] })

    const payload = await dispatchedPayload(archivePath, join(managedFolder, "Survival"))

    assert.equal(payload.isBackupArchive, false)
  })

  it("does not mark a .tar.gz that merely happens to be a .tar.gz", async () => {
    // A game build lands in the versions folder and is every bit as much a
    // gzipped tar as a backup is. The name is not what decides this.
    const archivePath = writeArchive(versionsFolder, "vs_client_linux-x64_1.22.6.tar.gz")

    const payload = await dispatchedPayload(archivePath, join(versionsFolder, "1.22.6"))

    assert.equal(payload.isBackupArchive, false)
  })

  it("does not mark an archive whose path differs from the recorded one", async () => {
    // The comparison is on the whole resolved path, so a neighbour with a
    // similar name is not the recorded backup.
    const recorded = writeArchive(join(backupsFolder, "Installations", "Survival"), "Survival_2026-08-01.tar.gz")
    const neighbour = writeArchive(join(backupsFolder, "Installations", "Survival"), "Survival_2026-08-01.tar.gz.old.tar.gz")
    writeConfig({
      installations: [{ id: "a", name: "A", path: join(managedFolder, "Survival"), backups: [{ id: "b1", date: 1, path: recorded }] }] as unknown as ConfigType["installations"]
    })

    const payload = await dispatchedPayload(neighbour, join(managedFolder, "Survival"))

    assert.equal(payload.isBackupArchive, false)
  })

  it("marks an archive the config still records as a backup after the backups folder moved", async () => {
    // Changing the Backups folder in settings does not move the archives
    // already made, and those still have to restore.
    const archivePath = writeArchive(join(temporaryRoot, "OldBackups"), "Survival_2026-07-01.tar.gz")
    writeConfig({
      installations: [{ id: "a", name: "A", path: join(managedFolder, "Survival"), backups: [{ id: "b1", date: 1, path: archivePath }] }] as unknown as ConfigType["installations"]
    })

    const payload = await dispatchedPayload(archivePath, join(managedFolder, "Survival"))

    assert.equal(payload.isBackupArchive, true)
  })
})
