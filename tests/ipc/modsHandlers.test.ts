import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

// Value import of "electron" itself, after "./helpers/electronMock": that
// side-effect import is what registers the vi.mock("electron", ...) factory,
// and it has to run before anything (including this file) actually resolves
// "electron", or `dialog` below comes back undefined.
import { dialog } from "electron"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { pruneModIconCache } from "@src/ipc/adapters/modScan"
import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"

vi.mock("@src/ipc/adapters/modScan", async (importOriginal) => {
  const original = await importOriginal<typeof import("@src/ipc/adapters/modScan")>()
  return { ...original, pruneModIconCache: vi.fn().mockResolvedValue(undefined) }
})

// Real implementation, wrapped, so the crash-safety guarantee stays covered by
// atomicJsonFile.test.ts and this file only asserts that modpack export goes
// through the shared adapter with the pretty-printed spacing the exported file
// is meant to be read and edited with.
vi.mock("@src/ipc/atomicJsonFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/ipc/atomicJsonFile")>()
  return { writeJsonAtomic: vi.fn(actual.writeJsonAtomic) }
})

vi.mock("@src/ipc/pathPolicy", async (importOriginal) => {
  const original = await importOriginal<typeof import("@src/ipc/pathPolicy")>()
  return {
    ...original,
    assertManagedPath: vi.fn(async (value: unknown) => String(value))
  }
})

/**
 * Branch coverage for src/ipc/handlers/modsHandlers.ts's GET_INSTALLED_MODS,
 * EXPORT_MODPACK, and IMPORT_MODPACK. The scanning domain logic has deep
 * coverage through modScan.test.ts and the domain's scanInstalled tests;
 * GET_INSTALLED_MODS tests here focus on the handler shell and its
 * integration with pruneModIconCache.
 */

let temporaryRoot: string
let userDataFolder: string
let modsFolder: string

type GetInstalledModsHandler = (event: IpcMainInvokeEvent, path: string) => Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }>
type ExportModpackHandler = (event: IpcMainInvokeEvent, manifest: unknown) => Promise<{ success: boolean; path?: string }>
type ImportModpackHandler = (event: IpcMainInvokeEvent) => Promise<{ success: boolean; manifest?: ModpackManifestType; error?: string }>

function getInstalledModsHandler(): GetInstalledModsHandler {
  return getIpcHandler<GetInstalledModsHandler>(IPC_CHANNELS.MODS_MANAGER.GET_INSTALLED_MODS)
}

function exportModpackHandler(): ExportModpackHandler {
  return getIpcHandler<ExportModpackHandler>(IPC_CHANNELS.MODS_MANAGER.EXPORT_MODPACK)
}

function importModpackHandler(): ImportModpackHandler {
  return getIpcHandler<ImportModpackHandler>(IPC_CHANNELS.MODS_MANAGER.IMPORT_MODPACK)
}

function validManifest(): ModpackManifestType {
  return { name: "My Modpack", gameVersion: "1.20.0", mods: [{ modid: "a", version: "1.0.0" }] }
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "mods-handlers-"))
  userDataFolder = join(temporaryRoot, "userData")
  modsFolder = join(temporaryRoot, "mods")
  mkdirSync(userDataFolder, { recursive: true })
  mkdirSync(modsFolder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  // Seed a config that makes pathPolicy accept modsFolder as a managed path.
  writeFileSync(
    join(userDataFolder, "config.json"),
    JSON.stringify({
      schemaVersion: 3,
      lastUsedInstallation: null,
      defaultInstallationsFolder: join(temporaryRoot, "Installations"),
      defaultVersionsFolder: join(temporaryRoot, "Versions"),
      backupsFolder: join(temporaryRoot, "Backups"),
      window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
      account: null,
      installations: [{ name: "test", path: modsFolder, gameVersion: "", startParams: "", mesaGlThread: false, envVars: "", backups: [] }],
      gameVersions: [],
      favMods: [],
      customIcons: []
    }),
    "utf-8"
  )

  // The `electron` mock (and its `dialog.showSaveDialog`/`showOpenDialog`
  // vi.fn()s) stays the same object across vi.resetModules(), unlike the real
  // modules underneath it; reset call history explicitly rather than relying
  // on afterEach's vi.restoreAllMocks() ordering.
  vi.mocked(dialog.showSaveDialog).mockReset()
  vi.mocked(dialog.showOpenDialog).mockReset()
  vi.mocked(pruneModIconCache).mockClear()

  vi.resetModules()
  await import("@src/ipc/handlers/modsHandlers")
  vi.mocked(writeJsonAtomic).mockClear()
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("GET_INSTALLED_MODS", () => {
  it("calls pruneModIconCache after a successful scan", async () => {
    const event = await createTrustedEvent()
    const result = await getInstalledModsHandler()(event, modsFolder)

    assert.deepEqual(result, { mods: [], errors: [] })
    assert.equal(vi.mocked(pruneModIconCache).mock.calls.length, 1)
  })

  it("does not call pruneModIconCache when the path does not exist", async () => {
    const missing = join(temporaryRoot, "nonexistent")
    const event = await createTrustedEvent()
    const result = await getInstalledModsHandler()(event, missing)

    assert.deepEqual(result, { mods: [], errors: [] })
    assert.equal(vi.mocked(pruneModIconCache).mock.calls.length, 0)
  })
})

describe("EXPORT_MODPACK", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => exportModpackHandler()(createUntrustedEvent(), validManifest()), /Unauthorized IPC sender/)
  })

  it("returns success: false without touching disk when the save dialog is cancelled", async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: "" })

    const event = await createTrustedEvent()
    const result = await exportModpackHandler()(event, validManifest())
    assert.deepEqual(result, { success: false })
  })

  it("returns success: false when the manifest itself is invalid, before ever opening the dialog", async () => {
    const event = await createTrustedEvent()
    const result = await exportModpackHandler()(event, { name: "", mods: [] })
    assert.deepEqual(result, { success: false })
    assert.equal(vi.mocked(dialog.showSaveDialog).mock.calls.length, 0)
  })

  it("returns success: false when the picked destination cannot be written to (permission denied)", async () => {
    // Pre-seed an existing file, then take away write permission on its
    // DIRECTORY. writeJsonAtomic writes the temp file and renames it over the
    // destination rather than truncating it in place, so a read-only target
    // file alone no longer blocks the write (rename() only needs directory
    // permission); the directory is what has to be locked down to force this
    // failure now.
    const exportDirectory = join(temporaryRoot, "exports")
    mkdirSync(exportDirectory, { recursive: true })
    const targetFile = join(exportDirectory, "My Modpack.json")
    writeFileSync(targetFile, "{}", "utf-8")
    chmodSync(exportDirectory, 0o500)

    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: targetFile })

    try {
      const event = await createTrustedEvent()
      const result = await exportModpackHandler()(event, validManifest())
      assert.deepEqual(result, { success: false })
    } finally {
      chmodSync(exportDirectory, 0o700)
    }
  })

  it("exports to a picked destination that does not exist yet, the normal save-as case", async () => {
    // A real save dialog almost always returns a path for a file that is not
    // there yet. This is the guard for the fix in issue #96: the destination
    // does not need to pre-exist, only to be user-approved (the save dialog
    // result is registered via registerUserSelectedPaths before the managed
    // path assertion runs), and the write is what creates the file.
    const exportDirectory = join(temporaryRoot, "exports-new")
    mkdirSync(exportDirectory, { recursive: true })
    const targetFile = join(exportDirectory, "Brand New Modpack.json")

    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: targetFile })

    const event = await createTrustedEvent()
    const manifest = validManifest()
    const result = await exportModpackHandler()(event, manifest)
    assert.deepEqual(result, { success: true, path: targetFile })

    const { readFileSync } = await import("node:fs")
    const rawText = readFileSync(targetFile, "utf-8")
    assert.deepEqual(JSON.parse(rawText), manifest)
    // Exported modpacks are meant to be read and shared by a player, so the
    // write goes through the atomic adapter with 2-space pretty-printing
    // rather than the minified form writeJsonAtomic defaults to.
    assert.equal(rawText, JSON.stringify(manifest, null, 2))
    assert.equal(vi.mocked(writeJsonAtomic).mock.calls.length, 1)
    assert.deepEqual(vi.mocked(writeJsonAtomic).mock.calls[0]?.[2], { spaces: 2 })
  })
})

describe("IMPORT_MODPACK", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => importModpackHandler()(createUntrustedEvent()), /Unauthorized IPC sender/)
  })

  it("returns success: false when the open dialog is cancelled", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })

    const event = await createTrustedEvent()
    const result = await importModpackHandler()(event)
    assert.deepEqual(result, { success: false })
  })

  it("returns success: false when the picked file exceeds the 2 MiB size cap", async () => {
    const importDirectory = join(temporaryRoot, "imports")
    mkdirSync(importDirectory, { recursive: true })
    const oversizeFile = join(importDirectory, "huge.json")
    writeFileSync(oversizeFile, "x".repeat(2 * 1024 * 1024 + 1), "utf-8")

    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [oversizeFile] })

    const event = await createTrustedEvent()
    const result = await importModpackHandler()(event)
    assert.deepEqual(result, { success: false, error: "Error reading modpack file." })
  })

  it("returns success: false with a generic error when the picked file is not a valid modpack manifest", async () => {
    const importDirectory = join(temporaryRoot, "imports")
    mkdirSync(importDirectory, { recursive: true })
    const badFile = join(importDirectory, "not-a-modpack.json")
    writeFileSync(badFile, JSON.stringify({ hello: "world" }), "utf-8")

    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [badFile] })

    const event = await createTrustedEvent()
    const result = await importModpackHandler()(event)
    assert.deepEqual(result, { success: false, error: "Error reading modpack file." })
  })

  it("returns success: false when a mod entry inside an otherwise well-shaped manifest is not an object", async () => {
    const importDirectory = join(temporaryRoot, "imports")
    mkdirSync(importDirectory, { recursive: true })
    const badFile = join(importDirectory, "bad-entry.json")
    writeFileSync(badFile, JSON.stringify({ name: "Pack", gameVersion: "1.20.0", mods: [123] }), "utf-8")

    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [badFile] })

    const event = await createTrustedEvent()
    const result = await importModpackHandler()(event)
    assert.deepEqual(result, { success: false, error: "Error reading modpack file." })
  })

  it("returns success: false with a generic error when the picked file is not even valid JSON", async () => {
    const importDirectory = join(temporaryRoot, "imports")
    mkdirSync(importDirectory, { recursive: true })
    const badFile = join(importDirectory, "not-json.json")
    writeFileSync(badFile, "{ not json", "utf-8")

    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [badFile] })

    const event = await createTrustedEvent()
    const result = await importModpackHandler()(event)
    assert.deepEqual(result, { success: false, error: "Error reading modpack file." })
  })

  it("imports a valid modpack manifest", async () => {
    const importDirectory = join(temporaryRoot, "imports")
    mkdirSync(importDirectory, { recursive: true })
    const goodFile = join(importDirectory, "modpack.json")
    writeFileSync(goodFile, JSON.stringify(validManifest()), "utf-8")

    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [goodFile] })

    const event = await createTrustedEvent()
    const result = await importModpackHandler()(event)
    assert.deepEqual(result, { success: true, manifest: validManifest() })
  })
})
