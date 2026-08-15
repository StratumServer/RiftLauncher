import { app, dialog, ipcMain } from "electron"
import fse from "fs-extra"
import yauzl from "yauzl"
import { IPC_CHANNELS } from "../ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertManagedPath } from "@src/ipc/pathPolicy"
import { assertSafeFileName, assertString, isRecord } from "@src/ipc/validation"
import { registerUserSelectedPaths } from "@src/ipc/pathPolicy"
import { logMessage } from "@src/utils/logManager"
import { join } from "path"
import JSON5 from "json5"
import { v4 as uuidv4 } from "uuid"

const MAX_MOD_FILES = 2_000
const MAX_MODINFO_BYTES = 1 * 1024 * 1024
const MAX_MOD_IMAGE_BYTES = 8 * 1024 * 1024
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

function modString(value: unknown, maxLength = 4_096): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0") ? value : undefined
}

function modStringArray(value: unknown, maxItems = 256): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined
  const values = value.map((entry) => modString(entry, 512))
  return values.every((entry): entry is string => entry !== undefined) ? values : undefined
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

    const infoMods = await getMods(path)

    logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [GET_INSTALLED_MODS] Found ${infoMods.mods.length} mods and ${infoMods.errors.length} mods with errors.`)
    if (infoMods.errors.length > 0)
      logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [GET_INSTALLED_MODS] Found ${infoMods.errors.length} mods with errors: ${infoMods.errors.map((mwe) => mwe.zipname)}`)
    return { mods: infoMods.mods, errors: infoMods.errors }
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
    const safeOutputPath = await assertManagedPath(result.filePath, "modpack path")
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

/**
 * Get a list of mods in a folder and read the modinfo.json of each one to get the mod information.
 *
 * @param {string} path The path to the folder with the mods.
 * @returns {Promise<{mods: InstalledModType[]; errors: ErrorInstalledModType[]}>} A list with the succesfully parsed mods and another list with the mods that threw an error.
 */
async function getMods(path: string): Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }> {
  const pathToImages = join(app.getPath("userData"), "Cache", "Images", "Mods")

  const mods: InstalledModType[] = []
  const errors: ErrorInstalledModType[] = []

  const files: string[] = []
  for (const file of await fse.readdir(path)) {
    if (files.length >= MAX_MOD_FILES || !file.toLowerCase().endsWith(".zip")) continue
    try {
      assertSafeFileName(file)
      if (!(await fse.lstat(join(path, file))).isSymbolicLink()) files.push(file)
    } catch {
      // Ignore invalid or disappearing entries while scanning a user-managed directory.
    }
  }

  logMessage("info", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] Found ${files.length} zip files. Starting reading them looking for mods.`)

  // Parse in bounded batches to avoid unbounded archive handles and buffers.
  for (let batchStart = 0; batchStart < files.length; batchStart += 16) {
    await Promise.all(
      files.slice(batchStart, batchStart + 16).map((file) => {
        const zipPath = join(path, file)

        return new Promise<void>((resolve) => {
          let imageFound: string | undefined = undefined
          let modFound: InstalledModType | undefined = undefined

          yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
            if (err) {
              logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error opening zip file.`)
              logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error opening zip file: ${err}`)
              errors.push({ zipname: file, path: zipPath })
              return resolve()
            }

            if (zip.isOpen) zip.readEntry()

            function closeZipReturnResolve(): void {
              if (zip && zip.isOpen) {
                zip.close()
                return resolve()
              } else {
                return resolve()
              }
            }

            zip.on("entry", (entry) => {
              if (entry.fileName === "modinfo.json") {
                if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_MODINFO_BYTES) {
                  errors.push({ zipname: file, path: zipPath })
                  return closeZipReturnResolve()
                }
                zip.openReadStream(entry, (err, stream) => {
                  if (err) {
                    logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error reading stream for ${entry}.`)
                    logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error reading stream for ${entry}: ${err}`)
                    errors.push({ zipname: file, path: zipPath })
                    closeZipReturnResolve()
                    return
                  }

                  let data = ""
                  let dataBytes = 0
                  stream.on("data", (chunk) => {
                    dataBytes += Buffer.byteLength(chunk)
                    if (dataBytes > MAX_MODINFO_BYTES) {
                      stream.destroy()
                      return
                    }
                    data += chunk
                  })
                  stream.on("end", () => {
                    try {
                      const json = JSON5.parse(data)

                      const mod: InstalledModType = {
                        name: modString(json["name"]) ?? modString(json["Name"]) ?? "",
                        modid: modString(json["modid"], 256) ?? modString(json["Modid"], 256) ?? modString(json["ModID"], 256) ?? modString(json["modID"], 256) ?? modString(json["modId"], 256) ?? "",
                        version: modString(json["version"], 256) ?? modString(json["Version"], 256) ?? "",
                        path: zipPath,
                        description: modString(json["description"]) ?? modString(json["Description"]),
                        side: modString(json["side"], 128) ?? modString(json["Side"], 128),
                        authors: modStringArray(json["authors"]) ?? modStringArray(json["Authors"]) ?? (modString(json["author"], 512) ? [modString(json["author"], 512) as string] : undefined),
                        contributors: modStringArray(json["contributors"]) ?? modStringArray(json["Contributors"]),
                        type: modString(json["type"], 128) ?? modString(json["Type"], 128)
                      }

                      if (mod.modid && mod.version && mod.name && mod.path) {
                        modFound = mod

                        if (imageFound) {
                          modFound._image = imageFound

                          mods.push(modFound)
                        }
                      } else {
                        logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Couldn't identify a mod.`)
                        logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Couldn't identify a mod.`)
                        errors.push({ zipname: file, path: zipPath })
                        resolve()
                      }
                    } catch (err) {
                      logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error parsing modinfo.json.`)
                      logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error parsing modinfo.json: ${err}`)
                      errors.push({ zipname: file, path: zipPath })
                      closeZipReturnResolve()
                    } finally {
                      if (modFound && imageFound) closeZipReturnResolve()
                      if (zip.isOpen) zip.readEntry()
                    }
                  })

                  stream.on("error", (err) => {
                    logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error reading modinfo.json.`)
                    logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error reading modinfo.json: ${err}`)
                    closeZipReturnResolve()
                  })
                })
              } else if (entry.fileName === "modicon.png") {
                if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_MOD_IMAGE_BYTES) {
                  errors.push({ zipname: file, path: zipPath })
                  return closeZipReturnResolve()
                }
                zip.openReadStream(entry, (err, stream) => {
                  if (err) {
                    logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error reading stream for ${entry}.`)
                    logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error reading stream for ${entry}: ${err}`)
                    closeZipReturnResolve()
                    return
                  }

                  const chunks: Buffer[] = []
                  let imageBytes = 0
                  stream.on("data", (chunk) => {
                    imageBytes += Buffer.byteLength(chunk)
                    if (imageBytes > MAX_MOD_IMAGE_BYTES) {
                      stream.destroy()
                      return
                    }
                    chunks.push(Buffer.from(chunk))
                  })
                  stream.on("end", async () => {
                    try {
                      const imageBuffer = Buffer.concat(chunks)

                      const imageName = `${uuidv4()}.png`

                      const imagePath = join(pathToImages, imageName)

                      await fse.ensureDir(pathToImages)

                      await fse.writeFile(imagePath, imageBuffer)

                      imageFound = imageName

                      if (modFound) {
                        modFound._image = imageName

                        mods.push(modFound)
                      }
                    } catch (imageErr) {
                      logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error saving the mod's logo.`)
                    } finally {
                      if (modFound && imageFound) closeZipReturnResolve()
                      if (zip.isOpen) zip.readEntry()
                    }
                  })

                  stream.on("error", (err) => {
                    logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error reading image.png.`)
                    logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error reading image.png: ${err}`)
                    closeZipReturnResolve()
                  })
                })
              } else {
                if (zip.isOpen) zip.readEntry()
              }
            })

            zip.on("end", () => {
              if (modFound && !imageFound) mods.push(modFound)
              closeZipReturnResolve()
            })

            zip.on("error", (err) => {
              logMessage("error", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error with ZIP file.`)
              logMessage("debug", `[back] [mods] [ipc/handlers/modsHandlers.ts] [getModsInfo] [${file}] Error with ZIP file: ${err}`)
              errors.push({ zipname: file, path: zipPath })
              closeZipReturnResolve()
            })
          })
        })
      })
    )
  }
  return { mods: mods, errors: errors }
}
