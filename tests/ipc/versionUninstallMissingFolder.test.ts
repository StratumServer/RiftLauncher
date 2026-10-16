import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import "./helpers/electronMock"
import { clearAppEventListeners, createTrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { CURRENT_CONFIG_SCHEMA } from "@domain/config/migrations"
import { uninstallGameVersion } from "@domain/versions/uninstall"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * A VS Version whose folder is gone (#732), run through the real host handlers the renderer's
 * file system port calls, not a fake. The host keeps refusing to delete a path that does not
 * exist, so the uninstall has to notice the missing folder itself.
 */
vi.mock("@src/ipc/workers/compressWorker?modulePath", () => ({ default: "compressWorker-path" }))
vi.mock("@src/ipc/workers/extractWorker?modulePath", () => ({ default: "extractWorker-path" }))
vi.mock("@src/ipc/workers/innoExtractWorker?modulePath", () => ({ default: "innoExtractWorker-path" }))
vi.mock("@src/ipc/workers/downloadWorker?modulePath", () => ({ default: "downloadWorker-path" }))
vi.mock("@src/ipc/workerManager", () => ({ acquireWorker: vi.fn() }))

let temporaryRoot: string
let versionsFolder: string
let userDataFolder: string

function writeConfig(versionFolders: string[]): void {
  writeFileSync(
    join(userDataFolder, "config.json"),
    JSON.stringify({
      schemaVersion: CURRENT_CONFIG_SCHEMA,
      lastUsedInstallation: null,
      defaultInstallationsFolder: join(temporaryRoot, "Installations"),
      defaultVersionsFolder: versionsFolder,
      backupsFolder: join(temporaryRoot, "Backups"),
      window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
      accounts: [],
      activeAccountId: null,
      installations: [],
      gameVersions: versionFolders.map((path, index) => ({ id: `gv-${index}`, version: "1.22.7", label: "1.22.7", path })),
      favMods: [],
      customIcons: []
    }),
    "utf-8"
  )
}

type PathHandler = (event: unknown, path: string) => Promise<boolean>

/** The same two calls `createFileSystemPort` makes, answered by the real handlers. */
async function hostPorts(): Promise<{ exists: (path: string) => Promise<boolean>; remove: (path: string) => Promise<boolean> }> {
  clearAppEventListeners()
  vi.resetModules()
  await import("@src/ipc/handlers/pathsHandlers")
  const event = await createTrustedEvent()
  const check = getIpcHandler<PathHandler>(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EXISTS)
  const del = getIpcHandler<PathHandler>(IPC_CHANNELS.PATHS_MANAGER.DELETE_PATH)
  return { exists: (path) => check(event, path), remove: (path) => del(event, path) }
}

function finishedRow(path: string): Parameters<typeof uninstallGameVersion>[1] {
  return { version: { version: "1.22.7", path, isPlaying: false, isDeleting: false, linked: false }, usedByInstallations: [], confirmedInUse: false }
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "version-uninstall-missing-"))
  versionsFolder = join(temporaryRoot, "Versions")
  userDataFolder = join(temporaryRoot, "userData")
  for (const folder of [userDataFolder, versionsFolder, join(temporaryRoot, "Installations"), join(temporaryRoot, "Backups")]) mkdirSync(folder, { recursive: true })
  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

describe("uninstalling a VS Version whose folder is gone, against the real host", () => {
  it("drops a finished row whose folder the player deleted by hand, on every try", async () => {
    const folder = join(versionsFolder, "1.22.7")
    mkdirSync(folder)
    writeConfig([folder])
    rmSync(folder, { recursive: true })

    const fileSystem = await hostPorts()

    assert.deepEqual(await uninstallGameVersion({ fileSystem }, finishedRow(folder)), { ok: true, folderRemoved: true })
    assert.deepEqual(await uninstallGameVersion({ fileSystem }, finishedRow(folder)), { ok: true, folderRemoved: true })
  })

  it("drops the row after an uninstall cut off between the folder delete and the config save", async () => {
    const folder = join(versionsFolder, "1.22.7")
    mkdirSync(folder)
    writeFileSync(join(folder, "Vintagestory"), "x")
    writeConfig([folder])

    const first = await uninstallGameVersion({ fileSystem: await hostPorts() }, finishedRow(folder))
    assert.deepEqual(first, { ok: true, folderRemoved: true })
    assert.equal(existsSync(folder), false)

    // The launcher is killed here: config.json still lists the version. Next start, same row.
    const next = await uninstallGameVersion({ fileSystem: await hostPorts() }, finishedRow(folder))
    assert.deepEqual(next, { ok: true, folderRemoved: true })
  })

  it("drops a row whose folder sat on a drive that is not there", async () => {
    const folder = join(versionsFolder, "unplugged", "1.22.7")
    writeConfig([folder])

    assert.deepEqual(await uninstallGameVersion({ fileSystem: await hostPorts() }, finishedRow(folder)), { ok: true, folderRemoved: true })
  })

  it("still deletes a folder that is there", async () => {
    const folder = join(versionsFolder, "1.22.7")
    mkdirSync(folder)
    writeConfig([folder])

    assert.deepEqual(await uninstallGameVersion({ fileSystem: await hostPorts() }, finishedRow(folder)), { ok: true, folderRemoved: true })
    assert.equal(existsSync(folder), false)
  })

  it("keeps the host refusing to delete a path that does not exist", async () => {
    const folder = join(versionsFolder, "1.22.7")
    writeConfig([folder])

    const fileSystem = await hostPorts()

    assert.equal(await fileSystem.exists(folder), false)
    assert.equal(await fileSystem.remove(folder), false)
  })
})
