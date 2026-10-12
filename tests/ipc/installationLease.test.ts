import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fse from "fs-extra"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { createInstallationLeasePort } from "../../src/renderer/src/adapters/installationLease"
import { makeInstallationBackup } from "@domain/installations/backup"
import { restoreInstallationBackup } from "@domain/installations/restore"
import type { CloseGuard, FileSystem } from "@domain/ports"

vi.mock("@src/ipc/workers/compression", () => ({ runCompression: vi.fn() }))
vi.mock("@src/ipc/workers/extraction", () => ({ extractTarGz: vi.fn() }))
vi.mock("@src/ipc/archiveValidation", () => ({ validateWorldBackupArchive: vi.fn(async () => undefined) }))

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

let root: string
let instRoot: string
let backups: string
let event: IpcMainInvokeEvent
let installationActivity: typeof import("@src/ipc/installationActivity")

function handler(channel: string): Handler {
  return getIpcHandler<Handler>(channel)
}

function installation(id: string, path: string): InstallationType {
  return {
    id,
    name: id,
    icon: "",
    path,
    version: "1.22.7",
    gameVersionId: `v-${id}`,
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    worldBackups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: ""
  }
}

function writeConfig(list: InstallationType[]): void {
  writeFileSync(
    join(root, "userData", "config.json"),
    JSON.stringify({
      schemaVersion: 6,
      lastUsedInstallation: null,
      defaultInstallationsFolder: instRoot,
      defaultVersionsFolder: join(root, "versions"),
      backupsFolder: backups,
      window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
      accounts: [],
      activeAccountId: null,
      installations: list,
      gameVersions: [],
      favMods: [],
      customIcons: []
    }),
    "utf8"
  )
}

const noGuard: CloseGuard = { acquire: () => (): void => {} }

const fsPort: FileSystem = {
  exists: (path) => fse.pathExists(path),
  remove: async (path) => {
    await fse.remove(path)
    return true
  },
  move: async (from, to) => {
    try {
      await fse.move(from, to)
      return true
    } catch {
      return false
    }
  }
}

/** The renderer's own bridge, answered by the real main-process handlers instead of Electron. */
function stubBridge(): void {
  vi.stubGlobal("window", {
    api: {
      installationActivity: {
        acquireLease: (installationId: string, token: string) => handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.ACQUIRE_LEASE)(event, installationId, token),
        releaseLease: (token: string) => handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.RELEASE_LEASE)(event, token)
      }
    }
  })
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition")
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function snapshot(id: string, path: string): Parameters<typeof restoreInstallationBackup>[1]["installation"] {
  return { id, name: id, path, backupsLimit: 3, compressionLevel: 6, backups: [], isBackingUp: false, isPlaying: false, isRestoringBackup: false }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "installation-lease-"))
  instRoot = join(root, "installations")
  backups = join(root, "backups")
  for (const dir of [join(root, "userData"), instRoot, backups, join(root, "versions")]) mkdirSync(dir, { recursive: true })
  setElectronUserDataPath(join(root, "userData"))
  setElectronPath("appData", join(root, "appData"))
  setElectronPath("home", root)
  setElectronPath("appRoot", join(root, "app"))

  vi.resetModules()
  installationActivity = await import("@src/ipc/installationActivity")
  await import("@src/ipc/handlers/worldsHandlers")
  await import("@src/ipc/handlers/installationActivityHandlers")
  event = await createTrustedEvent()
  stubBridge()
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

describe("installation lease channels", () => {
  it("rejects an untrusted sender and a malformed request", async () => {
    const acquire = handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.ACQUIRE_LEASE)
    const release = handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.RELEASE_LEASE)

    await assert.rejects(async () => acquire(createUntrustedEvent(), "A", "token-1"), /Unauthorized IPC sender/)
    await assert.rejects(async () => release(createUntrustedEvent(), "token-1"), /Unauthorized IPC sender/)
    await assert.rejects(async () => acquire(event, 7, "token-1"), /Invalid installation id/)
    await assert.rejects(async () => acquire(event, "", "token-1"), /Invalid installation id/)
    await assert.rejects(async () => acquire(event, "x".repeat(129), "token-1"), /Invalid installation id/)
    await assert.rejects(async () => acquire(event, "A\0B", "token-1"), /Invalid installation id/)
    await assert.rejects(async () => acquire(event, "A", 7), /Invalid/)
  })

  it("holds the installation until its token is released, and ignores a token it does not know", async () => {
    const acquire = handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.ACQUIRE_LEASE)
    const release = handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.RELEASE_LEASE)

    assert.deepEqual(await acquire(event, "A", "token-1"), { ok: true })
    assert.deepEqual(await acquire(event, "A", "token-2"), { ok: false, reason: "busy" })
    assert.equal(installationActivity.markInstallationPlaying("A"), false)
    await assert.rejects(async () => acquire(event, "B", "token-1"), /already in use/)

    await release(event, "unknown-token")
    assert.deepEqual(await acquire(event, "A", "token-3"), { ok: false, reason: "busy" })

    await release(event, "token-1")
    assert.deepEqual(await acquire(event, "A", "token-3"), { ok: true })
    await release(event, "token-3")
    assert.equal(installationActivity.markInstallationPlaying("A"), true)
  })

  it("leases an installation id the config accepts even when it is not a UUID", async () => {
    const acquire = handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.ACQUIRE_LEASE)
    const release = handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.RELEASE_LEASE)
    const id = "Survival.1 (old)"

    assert.deepEqual(await acquire(event, id, "token-1"), { ok: true })
    assert.deepEqual(await acquire(event, id, "token-2"), { ok: false, reason: "busy" })
    assert.deepEqual(await acquire(event, "y".repeat(128), "token-3"), { ok: true })
    await release(event, "token-1")
    await release(event, "token-3")
  })

  it("backs up and restores an installation whose id is not a UUID", async () => {
    const dir = join(instRoot, "odd")
    mkdirSync(join(dir, "Saves"), { recursive: true })
    const archive = join(backups, "odd.tar.gz")
    writeFileSync(archive, "x")
    writeConfig([installation("Survival.1", dir)])

    const made = await makeInstallationBackup(
      {
        fileSystem: fsPort,
        archiver: { compress: async (_request, onComplete): Promise<void> => onComplete({ ok: true }) },
        clock: { now: () => 1 },
        ids: { newId: () => "id" },
        paths: { join: async (parts) => parts.join("/") },
        closeGuard: noGuard,
        installationLease: createInstallationLeasePort()
      },
      { installation: snapshot("Survival.1", dir), backupsFolder: backups }
    )
    const restored = await restoreInstallationBackup(
      {
        fileSystem: fsPort,
        ids: { newId: () => "tok" },
        closeGuard: noGuard,
        installationLease: createInstallationLeasePort(),
        extractor: {
          extract: async (request, onComplete): Promise<void> => {
            mkdirSync(join(request.outputFolder, "Saves"), { recursive: true })
            onComplete({ ok: true })
          }
        }
      },
      { installation: snapshot("Survival.1", dir), backup: { id: "bk", date: 1, path: archive } }
    )

    assert.equal(made.ok, true)
    assert.deepEqual(restored, { ok: true })
    assert.equal(installationActivity.markInstallationPlaying("Survival.1"), true)
  })

  it("answers playing for an installation a game runs on", async () => {
    installationActivity.markInstallationPlaying("A")

    assert.deepEqual(await handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.ACQUIRE_LEASE)(event, "A", "token-1"), { ok: false, reason: "playing" })
  })

  it("refuses a lease while a world operation holds the installation", async () => {
    const held = installationActivity.tryAcquireInstallationOperation(["A", "B"])
    assert.equal(held.ok, true)

    assert.deepEqual(await handler(IPC_CHANNELS.INSTALLATION_ACTIVITY.ACQUIRE_LEASE)(event, "B", "token-1"), { ok: false, reason: "busy" })
    if (held.ok) held.release()
  })
})

describe("restoring an installation backup next to a world transfer", () => {
  function setUpTwoInstallations(): { a: string; b: string; archive: string } {
    const a = join(instRoot, "A")
    const b = join(instRoot, "B")
    mkdirSync(join(a, "Saves"), { recursive: true })
    mkdirSync(join(b, "Saves"), { recursive: true })
    writeFileSync(join(a, "Saves", "MyWorld.vcdbs"), "precious world", "utf8")
    const archive = join(backups, "B.tar.gz")
    writeFileSync(archive, "x")
    writeConfig([installation("A", a), installation("B", b)])
    return { a, b, archive }
  }

  function startRestore(b: string, archive: string): { done: Promise<unknown>; extracting: () => boolean; finishExtraction: () => void } {
    let finish!: () => void
    const extractionGate = new Promise<void>((resolve) => (finish = resolve))
    let started = false
    const done = restoreInstallationBackup(
      {
        fileSystem: fsPort,
        ids: { newId: () => "tok" },
        closeGuard: noGuard,
        installationLease: createInstallationLeasePort(),
        extractor: {
          extract: async (request, onComplete): Promise<void> => {
            started = true
            mkdirSync(join(request.outputFolder, "Saves"), { recursive: true })
            await extractionGate
            onComplete({ ok: true })
          }
        }
      },
      { installation: snapshot("B", b), backup: { id: "bk", date: 1, path: archive } }
    )
    return { done, extracting: () => started, finishExtraction: finish }
  }

  it("refuses to move a world into the installation being restored, and keeps it in the source", async () => {
    const { a, b, archive } = setUpTwoInstallations()
    const restore = startRestore(b, archive)
    await waitFor(restore.extracting)

    const moved = await handler(IPC_CHANNELS.WORLDS_MANAGER.TRANSFER)(event, "A", "MyWorld.vcdbs", "B", "move")
    restore.finishExtraction()
    const restored = await restore.done

    assert.deepEqual(moved, { ok: false, reason: "world-busy" })
    assert.deepEqual(restored, { ok: true })
    assert.equal(readFileSync(join(a, "Saves", "MyWorld.vcdbs"), "utf8"), "precious world")
    assert.equal(existsSync(join(b, "Saves", "MyWorld.vcdbs")), false)
  })

  it("refuses to move a world out of the installation being restored", async () => {
    const { a, b, archive } = setUpTwoInstallations()
    writeFileSync(join(b, "Saves", "Other.vcdbs"), "other world", "utf8")
    const restore = startRestore(b, archive)
    await waitFor(restore.extracting)

    const moved = await handler(IPC_CHANNELS.WORLDS_MANAGER.TRANSFER)(event, "B", "Other.vcdbs", "A", "move")
    restore.finishExtraction()
    await restore.done

    assert.deepEqual(moved, { ok: false, reason: "world-busy" })
    assert.equal(existsSync(join(a, "Saves", "Other.vcdbs")), false)
  })

  it("lets the transfer through again once the restore is over", async () => {
    const { b, archive } = setUpTwoInstallations()
    const restore = startRestore(b, archive)
    await waitFor(restore.extracting)
    restore.finishExtraction()
    await restore.done

    const moved = await handler(IPC_CHANNELS.WORLDS_MANAGER.TRANSFER)(event, "A", "MyWorld.vcdbs", "B", "move")

    assert.equal((moved as { ok: boolean }).ok, true)
    assert.equal(readFileSync(join(b, "Saves", "MyWorld.vcdbs"), "utf8"), "precious world")
  })

  it("refuses to restore while a world is being moved into the installation", async () => {
    const { a, b, archive } = setUpTwoInstallations()
    const hold = installationActivity.tryAcquireInstallationOperation(["A", "B"])
    assert.equal(hold.ok, true)

    const restored = await restoreInstallationBackup(
      {
        fileSystem: fsPort,
        ids: { newId: () => "tok" },
        closeGuard: noGuard,
        installationLease: createInstallationLeasePort(),
        extractor: { extract: async (): Promise<void> => assert.fail("extracted") }
      },
      { installation: snapshot("B", b), backup: { id: "bk", date: 1, path: archive } }
    )

    assert.deepEqual(restored, { ok: false, reason: "installation-busy", strandedPath: null })
    assert.equal(existsSync(a), true)
    if (hold.ok) hold.release()
  })

  it("refuses a launch while the restore runs and allows it afterwards", async () => {
    const { b, archive } = setUpTwoInstallations()
    const restore = startRestore(b, archive)
    await waitFor(restore.extracting)

    assert.equal(installationActivity.markInstallationPlaying("B"), false)
    restore.finishExtraction()
    await restore.done

    assert.equal(installationActivity.markInstallationPlaying("B"), true)
  })

  it("refuses a world move into an installation while it is being backed up", async () => {
    const { a, b } = setUpTwoInstallations()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => (finish = resolve))
    let compressing = false
    const backup = makeInstallationBackup(
      {
        fileSystem: fsPort,
        archiver: {
          compress: async (_request, onComplete): Promise<void> => {
            compressing = true
            await gate
            onComplete({ ok: true })
          }
        },
        clock: { now: () => 1 },
        ids: { newId: () => "id" },
        paths: { join: async (parts) => parts.join("/") },
        closeGuard: noGuard,
        installationLease: createInstallationLeasePort()
      },
      { installation: snapshot("B", b), backupsFolder: backups }
    )
    await waitFor(() => compressing)

    const moved = await handler(IPC_CHANNELS.WORLDS_MANAGER.TRANSFER)(event, "A", "MyWorld.vcdbs", "B", "move")
    finish()
    const made = await backup

    assert.deepEqual(moved, { ok: false, reason: "world-busy" })
    assert.equal(made.ok, true)
    assert.equal(existsSync(join(a, "Saves", "MyWorld.vcdbs")), true)
  })
})
