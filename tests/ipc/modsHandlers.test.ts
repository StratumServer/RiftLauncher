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

/**
 * Branch coverage for src/ipc/handlers/modsHandlers.ts's EXPORT_MODPACK and
 * IMPORT_MODPACK, previously entirely unimported by a test (0%).
 * GET_INSTALLED_MODS is left alone: its own scanning logic already has deep
 * coverage through modScan.test.ts and the domain's scanInstalled tests, and
 * the handler wrapper around it adds nothing this campaign is chasing.
 */

let temporaryRoot: string
let userDataFolder: string

type ExportModpackHandler = (event: IpcMainInvokeEvent, manifest: unknown) => Promise<{ success: boolean; path?: string }>
type ImportModpackHandler = (event: IpcMainInvokeEvent) => Promise<{ success: boolean; manifest?: ModpackManifestType; error?: string }>

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
  mkdirSync(userDataFolder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  // The `electron` mock (and its `dialog.showSaveDialog`/`showOpenDialog`
  // vi.fn()s) stays the same object across vi.resetModules(), unlike the real
  // modules underneath it; reset call history explicitly rather than relying
  // on afterEach's vi.restoreAllMocks() ordering.
  vi.mocked(dialog.showSaveDialog).mockReset()
  vi.mocked(dialog.showOpenDialog).mockReset()

  vi.resetModules()
  await import("@src/ipc/handlers/modsHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
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
    // The target must already exist for assertManagedPath to admit it here:
    // EXPORT_MODPACK calls it without { allowMissing: true } (see the PR
    // description -- this looks like a real defect, since a save dialog's
    // whole point is usually a filename that does NOT exist yet). Pre-seeding
    // the file is what isolates "the write itself fails" from that gap.
    const exportDirectory = join(temporaryRoot, "exports")
    mkdirSync(exportDirectory, { recursive: true })
    const targetFile = join(exportDirectory, "My Modpack.json")
    writeFileSync(targetFile, "{}", "utf-8")
    // Read-only on the FILE itself: overwriting an existing file's contents
    // only needs write permission on the file, not its directory, so a
    // directory-level chmod alone would not have blocked this write.
    chmodSync(targetFile, 0o400)

    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: targetFile })

    try {
      const event = await createTrustedEvent()
      const result = await exportModpackHandler()(event, validManifest())
      assert.deepEqual(result, { success: false })
    } finally {
      chmodSync(targetFile, 0o600)
    }
  })

  it("defect: a picked destination that does not exist yet is refused as an unmanaged path, so export always fails for a new file name", async () => {
    // Documents the same gap the test above works around. A real save dialog
    // almost always returns a path for a file that is not there yet; this
    // pins that EXPORT_MODPACK's current behavior for that ordinary case is
    // success: false, not a successful export. See PR description.
    const exportDirectory = join(temporaryRoot, "exports-new")
    mkdirSync(exportDirectory, { recursive: true })
    const targetFile = join(exportDirectory, "Brand New Modpack.json")

    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: targetFile })

    const event = await createTrustedEvent()
    const result = await exportModpackHandler()(event, validManifest())
    assert.deepEqual(result, { success: false })

    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(targetFile), false, "nothing should have been written for a path assertManagedPath refused")
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
