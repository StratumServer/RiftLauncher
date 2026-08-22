import { dialog, ipcMain } from "electron"
import fse from "fs-extra"
import { IPC_CHANNELS } from "../ipcChannels"
import { createScanInstalledModsPorts, pruneModIconCache } from "@src/ipc/adapters/modScan"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertManagedPath, registerUserSelectedPaths } from "@src/ipc/pathPolicy"
import { assertString, isRecord } from "@src/ipc/validation"
import { logMessage } from "@src/utils/logManager"
import { scanInstalledMods } from "@domain/mods/scanInstalled"
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
  path = await assertManagedPath(path, "mods path", { allowMissing: true })
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
    await fse.writeFile(safeOutputPath, JSON.stringify(safeManifest, null, 2), "utf-8")

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
