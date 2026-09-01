import { dialog, ipcMain } from "electron"
import fse from "fs-extra"
import { basename, dirname, join } from "node:path"
import { IPC_CHANNELS } from "../ipcChannels"
import { createScanInstalledModsPorts, pruneModIconCache } from "@src/ipc/adapters/modScan"
import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertManagedModArchivePath, assertManagedPath, registerUserSelectedPaths } from "@src/ipc/pathPolicy"
import { assertBoolean, assertSafeFileName, assertString, isRecord } from "@src/ipc/validation"
import { getErrorMessage, logMessage } from "@src/utils/logManager"
import { renameModArchiveTo, scanInstalledMods } from "@domain/mods/scanInstalled"
import type { ScannedMod } from "@domain/mods/scanInstalled"

const MAX_MODPACK_ENTRIES = 2_000

function parseModpackManifest(value: unknown): ModpackManifestType {
  if (!isRecord(value) || !Array.isArray(value.mods) || value.mods.length > MAX_MODPACK_ENTRIES) throw new TypeError("Invalid modpack file structure")

  return {
    name: assertString(value.name, "modpack name", 256),
    gameVersion: assertString(value.gameVersion, "modpack game version", 128),
    mods: value.mods.map((entry) => {
      if (!isRecord(entry)) throw new TypeError("Invalid modpack entry")
      return { modid: assertString(entry.modid, "mod id", 256), version: assertString(entry.version, "mod version", 128) }
    })
  }
}

/**
 * Puts a scanned mod on the wire.
 *
 * The renderer reads the icon under `_image`, its own marker for a field the
 * launcher computed rather than read out of the archive, so the domain's plain
 * `image` is renamed on the way out and left off entirely when there is none.
 */
function toWireMod(mod: ScannedMod): InstalledModType {
  const { image, ...rest } = mod
  return image === undefined ? rest : { ...rest, _image: image }
}

ipcMain.handle(IPC_CHANNELS.MODS_MANAGER.GET_INSTALLED_MODS, async (event, path: string): Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }> => {
  assertTrustedIpcSender(event)
  // allowSymlinks: listing a Mods folder the user linked in is a read (#237).
  // The scan only ever opens the .zip files it finds, and the directory reader
  // still drops any entry that is itself a link, so nothing planted inside can
  // widen what gets opened. Deleting or replacing a mod goes through the strict
  // policy as before.
  path = await assertManagedPath(path, "mods path", { allowMissing: true, allowSymlinks: true })
  try {
    logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [GET_INSTALLED_MODS] Looking for mods at ${path}.`)

    if (!(await fse.pathExists(path))) {
      logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [GET_INSTALLED_MODS] That path does not exists. 0 mods detected.`)
      return { mods: [], errors: [] }
    }

    const scan = await scanInstalledMods(createScanInstalledModsPorts(), { folder: path })

    logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [GET_INSTALLED_MODS] Found ${scan.mods.length} mods and ${scan.errors.length} mods with errors.`)
    if (scan.errors.length > 0)
      logMessage(
        "debug",
        `[back] [mods] [ipc/handlers/modsHandlers.ts] [GET_INSTALLED_MODS] Found ${scan.errors.length} mods with errors: ${scan.errors.map((archive) => `${archive.zipname} (${archive.problem})`)}`
      )

    void pruneModIconCache()

    return { mods: scan.mods.map(toWireMod), errors: scan.errors.map((archive) => ({ zipname: archive.zipname, path: archive.path })) }
  } catch (err) {
    logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [GET_INSTALLED_MODS] Error getting installed mods.`)
    logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [GET_INSTALLED_MODS] Error getting installed mods: ${err}`)
    return { mods: [], errors: [] }
  }
})

/**
 * Turns one installed mod on or off by renaming its archive in place.
 *
 * The renderer names the file to act on and the state it wants, and nothing else. Everything about
 * the destination is derived here: the source is put through the same grade of check a deletion is,
 * bar the one exception a linked Mods folder buys it, because the name it has stops existing either
 * way, then its own file name is put through the guard
 * the scan applies to every entry it will open, and only then does the domain derive the target name
 * by adding or removing one fixed suffix. Nothing a caller sends is ever spliced into the name that
 * gets written, so the toggle cannot reach a file that a delete could not already reach.
 *
 * A name already taken stops the rename rather than overwriting: an installation holding both
 * `X.zip` and `X.zip.disabled` is a folder the player made by hand, and quietly destroying one of
 * the two is not this launcher's call to make.
 */
ipcMain.handle(IPC_CHANNELS.MODS_MANAGER.SET_MOD_ENABLED, async (event, pathValue: string, enabled: boolean): Promise<SetModEnabledResult> => {
  assertTrustedIpcSender(event)

  try {
    const wanted = assertBoolean(enabled, "mod enabled state")
    const safePath = await assertManagedModArchivePath(pathValue)
    const rename = renameModArchiveTo(assertSafeFileName(basename(safePath), "mod archive name"), wanted)

    if (!rename.ok) {
      logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [SET_MOD_ENABLED] Nothing to rename: ${rename.reason}.`)
      return rename.reason === "already-in-state" ? { ok: false, reason: "already-in-state" } : { ok: false, reason: "refused" }
    }

    const target = join(dirname(safePath), rename.fileName)
    // The folder is the one the source was just cleared in, and the name is derived rather than sent,
    // so what is left to check here is the grant. The walk is the source's job and it did it.
    await assertManagedPath(target, "mod archive path", { allowMissing: true, allowSymlinks: true })

    if (await fse.pathExists(target)) {
      logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [SET_MOD_ENABLED] The other name is already taken, leaving both archives alone.`)
      return { ok: false, reason: "name-taken" }
    }

    logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [SET_MOD_ENABLED] Renaming a mod archive to turn it ${wanted ? "on" : "off"}.`)
    // move rather than rename: it refuses an existing destination on every platform, so the check
    // above losing a race cannot end with one archive written over the other.
    await fse.move(safePath, target)

    return { ok: true, path: target }
  } catch (err) {
    logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [SET_MOD_ENABLED] Error renaming a mod archive.`)
    logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [SET_MOD_ENABLED] ${getErrorMessage(err)}`)
    return { ok: false, reason: "refused" }
  }
})

ipcMain.handle(IPC_CHANNELS.MODS_MANAGER.EXPORT_MODPACK, async (event, manifest: ModpackManifestType): Promise<{ success: boolean; path?: string }> => {
  assertTrustedIpcSender(event)
  try {
    const safeManifest = parseModpackManifest(manifest)
    logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [EXPORT_MODPACK] Exporting modpack "${safeManifest.name}" with ${safeManifest.mods.length} mods.`)

    const result = await dialog.showSaveDialog({
      title: "Export Modpack",
      defaultPath: safeManifest.name,
      filters: [{ name: "JSON", extensions: ["json"] }]
    })

    if (result.canceled || !result.filePath) {
      logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [EXPORT_MODPACK] Export cancelled.`)
      return { success: false }
    }

    registerUserSelectedPaths([result.filePath])
    const safeOutputPath = await assertManagedPath(result.filePath, "modpack path", { allowMissing: true })
    await writeJsonAtomic(safeOutputPath, safeManifest, { spaces: 2 })

    logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [EXPORT_MODPACK] Modpack exported to ${result.filePath}.`)
    return { success: true, path: result.filePath }
  } catch (err) {
    logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [EXPORT_MODPACK] Error exporting modpack.`)
    logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [EXPORT_MODPACK] Error exporting modpack: ${err}`)
    return { success: false }
  }
})

ipcMain.handle(IPC_CHANNELS.MODS_MANAGER.IMPORT_MODPACK, async (event): Promise<{ success: boolean; manifest?: ModpackManifestType; error?: string }> => {
  assertTrustedIpcSender(event)
  try {
    logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [IMPORT_MODPACK] Opening file dialog for modpack import.`)

    const result = await dialog.showOpenDialog({
      title: "Import Modpack",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [IMPORT_MODPACK] Import cancelled.`)
      return { success: false }
    }

    const filePath = result.filePaths[0]
    if (!filePath) {
      logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [IMPORT_MODPACK] Import cancelled.`)
      return { success: false }
    }
    registerUserSelectedPaths([filePath])
    const safeFilePath = await assertManagedPath(filePath, "modpack path")
    if ((await fse.stat(safeFilePath)).size > 2 * 1024 * 1024) throw new Error("Modpack file is too large")
    const raw = await fse.readFile(safeFilePath, "utf-8")
    const parsedManifest: unknown = JSON.parse(raw)

    const manifest = parseModpackManifest(parsedManifest)

    logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [IMPORT_MODPACK] Modpack "${manifest.name}" loaded with ${manifest.mods.length} mods.`)
    return { success: true, manifest }
  } catch (err) {
    logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [IMPORT_MODPACK] Error importing modpack.`)
    logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [IMPORT_MODPACK] Error importing modpack: ${err}`)
    return { success: false, error: "Error reading modpack file." }
  }
})
