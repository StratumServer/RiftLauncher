import { ipcMain, app, shell } from "electron"
import { path7za } from "7zip-bin"
import fse from "fs-extra"
import yauzl from "yauzl"
import { basename, extname, join, resolve, sep } from "path"
import os from "os"
import { spawn } from "child_process"
import type { IpcMainInvokeEvent } from "electron"

import { logMessage, getErrorMessage } from "@src/utils/logManager"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { createTrackedWorker, disposeTrackedWorker } from "@src/ipc/workerManager"
import {
  assertAllowedDownloadUrl,
  assertBoolean,
  assertInteger,
  assertPath,
  assertSafeFileName,
  assertSafeTaskId,
  isArchiveSymlink,
  isRecord,
  isSafeArchiveEntry,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_TOTAL_BYTES
} from "@src/ipc/validation"
import { assertManagedDeletionPath, assertManagedPath } from "@src/ipc/pathPolicy"
import { assertVerifiedArtifact, getTrustedDownloadHash, recordVerifiedArtifact } from "@src/ipc/artifactVerification"

import compressWorker from "@src/ipc/workers/compressWorker?modulePath"
import extractWorker from "@src/ipc/workers/extractWorker?modulePath"
import changePermsWorker from "@src/ipc/workers/changePermsWorker?modulePath"
import downloadWorkerPath from "@src/ipc/workers/downloadWorker?modulePath"

const sevenZipBin = app.isPackaged ? path7za.replace("app.asar", "app.asar.unpacked") : path7za
const MAX_ARCHIVE_ENTRIES = 100_000
const WORKER_TIMEOUTS_MS: Record<string, number> = {
  DOWNLOAD_ON_PATH: 45 * 60 * 1_000,
  EXTRACT_ON_PATH: 30 * 60 * 1_000,
  COMPRESS_ON_PATH: 30 * 60 * 1_000,
  CHANGE_PERMS: 10 * 60 * 1_000
}

function comparableArchiveEntry(entryName: string): string {
  const normalizedName = entryName.replace(/\\/g, "/")
  return process.platform === "win32" ? normalizedName.toLowerCase() : normalizedName
}

type WorkerMessage = {
  type: unknown
  progress?: unknown
  path?: unknown
  message?: unknown
}

function sendProgress(event: IpcMainInvokeEvent, channel: string | undefined, id: string, progress: number): void {
  if (channel && !event.sender.isDestroyed()) event.sender.send(channel, { id, progress })
}

function runTrackedWorker<T>(
  event: IpcMainInvokeEvent,
  id: string,
  progressChannel: string | undefined,
  workerPath: string,
  workerData: object,
  operationName: string,
  onFinished: (message: WorkerMessage) => T
): Promise<T> {
  const worker = createTrackedWorker(workerPath, workerData)

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let lastProgress = 0
    const timeout = setTimeout(
      () => {
        rejectOnce(new Error(`${operationName} timed out`))
      },
      WORKER_TIMEOUTS_MS[operationName] ?? 30 * 60 * 1_000
    )

    const cleanup = (): void => {
      clearTimeout(timeout)
      worker.removeAllListeners()
      disposeTrackedWorker(worker)
    }

    const resolveOnce = (value: T): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(value)
    }

    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error instanceof Error ? error : new Error(`${operationName} failed`))
    }

    worker.on("message", (message: unknown) => {
      if (!isRecord(message) || typeof message.type !== "string") {
        rejectOnce(new Error(`${operationName} returned an invalid worker message`))
        return
      }

      const workerMessage = message as WorkerMessage

      if (workerMessage.type === "progress") {
        if (typeof workerMessage.progress !== "number" || !Number.isFinite(workerMessage.progress) || workerMessage.progress < 0 || workerMessage.progress > 100) {
          rejectOnce(new Error(`${operationName} returned invalid progress`))
          return
        }

        if (workerMessage.progress < lastProgress) return
        lastProgress = workerMessage.progress
        sendProgress(event, progressChannel, id, workerMessage.progress)
        return
      }

      if (workerMessage.type === "finished") {
        try {
          resolveOnce(onFinished(workerMessage))
        } catch (err) {
          rejectOnce(err)
        }
        return
      }

      if (workerMessage.type === "error") {
        rejectOnce(new Error(typeof workerMessage.message === "string" ? workerMessage.message : `${operationName} failed`))
        return
      }

      rejectOnce(new Error(`${operationName} returned an unknown worker message`))
    })

    worker.once("error", (error) => {
      logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [${operationName}] Worker error.`)
      logMessage("debug", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [${operationName}] ${getErrorMessage(error)}`)
      rejectOnce(error)
    })

    worker.once("exit", (code) => {
      if (!settled) rejectOnce(new Error(`${operationName} worker exited with code ${code}`))
    })
  })
}

function validateZipArchive(filePath: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let totalUncompressedBytes = 0
    let entryCount = 0
    const entryNames = new Set<string>()

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) rejectPromise(error)
      else resolvePromise()
    }

    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        finish(new Error("Archive could not be read"))
        return
      }

      zipFile.on("entry", (entry) => {
        const entrySize = entry.uncompressedSize
        entryCount++
        const normalizedEntryName = typeof entry.fileName === "string" ? comparableArchiveEntry(entry.fileName) : ""
        if (
          entryCount > MAX_ARCHIVE_ENTRIES ||
          !isSafeArchiveEntry(entry.fileName) ||
          entryNames.has(normalizedEntryName) ||
          isArchiveSymlink(entry.externalFileAttributes) ||
          !Number.isFinite(entrySize) ||
          entrySize < 0 ||
          entrySize > MAX_ARCHIVE_ENTRY_BYTES ||
          totalUncompressedBytes + entrySize > MAX_ARCHIVE_TOTAL_BYTES
        ) {
          try {
            zipFile.close()
          } catch {
            // The archive may already be closed after a parse error.
          }
          finish(new Error("Archive contains an unsafe entry"))
          return
        }

        entryNames.add(normalizedEntryName)
        totalUncompressedBytes += entrySize
        zipFile.readEntry()
      })

      zipFile.once("end", () => finish())
      zipFile.once("error", () => finish(new Error("Archive could not be read")))
      zipFile.readEntry()
    })
  })
}

function validateSevenZipArchive(filePath: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const archiveLister = spawn(sevenZipBin, ["l", "-slt", "-bb0", filePath], { windowsHide: true })
    let output = ""
    let settled = false

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) rejectPromise(error)
      else resolvePromise()
    }

    archiveLister.stdout.on("data", (chunk) => {
      output += chunk.toString()
      if (Buffer.byteLength(output, "utf8") > 4 * 1024 * 1024) {
        archiveLister.kill()
        finish(new Error("Archive listing is too large"))
      }
    })
    archiveLister.stderr.on("data", () => {})
    archiveLister.on("error", (error) => finish(error))
    archiveLister.on("close", (code) => {
      if (settled) return
      if (code !== 0) {
        finish(new Error("Archive could not be listed"))
        return
      }

      const records = output.split(/\r?\n\s*\r?\n/)
      let entryCount = 0
      let totalUncompressedBytes = 0
      let firstRecord = true
      const entryNames = new Set<string>()
      for (const record of records) {
        const pathLine = record.split(/\r?\n/).find((line) => line.startsWith("Path = "))
        if (!pathLine) continue
        if (firstRecord) {
          firstRecord = false
          continue
        }

        const entryName = pathLine.slice("Path = ".length)
        const sizeLine = record.split(/\r?\n/).find((line) => line.startsWith("Size = "))
        const folderLine = record.split(/\r?\n/).find((line) => line.startsWith("Folder = "))
        const isFolder = folderLine?.slice("Folder = ".length).trim() === "+"
        const attributesLine = record.split(/\r?\n/).find((line) => line.startsWith("Attributes = "))
        const entrySize = sizeLine ? Number(sizeLine.slice("Size = ".length)) : 0
        entryCount++
        totalUncompressedBytes += Number.isFinite(entrySize) && entrySize >= 0 ? entrySize : 0

        if (
          entryCount > MAX_ARCHIVE_ENTRIES ||
          !isSafeArchiveEntry(entryName) ||
          entryNames.has(comparableArchiveEntry(entryName)) ||
          (attributesLine !== undefined && /(^|\s)L(\s|$)/.test(attributesLine)) ||
          (!isFolder && (!sizeLine || !Number.isFinite(entrySize) || entrySize < 0)) ||
          entrySize > MAX_ARCHIVE_ENTRY_BYTES ||
          totalUncompressedBytes > MAX_ARCHIVE_TOTAL_BYTES
        ) {
          finish(new Error("Archive contains an unsafe entry"))
          return
        }
        entryNames.add(comparableArchiveEntry(entryName))
      }

      finish()
    })
  })
}

async function validateArchive(filePath: string): Promise<void> {
  if (filePath.toLowerCase().endsWith(".zip")) return validateZipArchive(filePath)
  return validateSevenZipArchive(filePath)
}

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.GET_CURRENT_USER_DATA_PATH, (event): string => {
  assertTrustedIpcSender(event)
  return app.getPath("userData")
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.DELETE_PATH, async (event, pathValue: string): Promise<boolean> => {
  assertTrustedIpcSender(event)

  try {
    const safePath = await assertManagedDeletionPath(pathValue)
    logMessage("info", "[back] [ipc] [ipc/handlers/pathsHandlers.ts] [DELETE_PATH] Deleting an approved path.")
    await fse.remove(safePath)
    return true
  } catch (err) {
    logMessage("error", "[back] [ipc] [ipc/handlers/pathsHandlers.ts] [DELETE_PATH] Error deleting path.")
    logMessage("debug", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [DELETE_PATH] ${getErrorMessage(err)}`)
    return false
  }
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.FORMAT_PATH, (event, parts: string[]): string => {
  assertTrustedIpcSender(event)
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 32) throw new TypeError("Invalid path parts")

  const safeParts = parts.map((part) => {
    const safePart = assertPath(part, "path part")
    if (safePart === "." || safePart === "..") throw new TypeError("Invalid path part")
    return safePart
  })

  return join(...safeParts)
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.REMOVE_FILE_FROM_PATH, (event, pathValue: string): string => {
  assertTrustedIpcSender(event)
  const safePath = assertPath(pathValue)
  return safePath.split(sep).slice(0, -1).join(sep)
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EMPTY, async (event, pathValue: string): Promise<boolean> => {
  assertTrustedIpcSender(event)
  const safePath = await assertManagedPath(pathValue, "path", { allowMissing: true })
  if (!(await fse.pathExists(safePath))) return true
  return (await fse.stat(safePath)).isDirectory() && (await fse.readdir(safePath)).length === 0
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EXISTS, async (event, pathValue: string): Promise<boolean> => {
  assertTrustedIpcSender(event)
  const safePath = await assertManagedPath(pathValue, "path", { allowMissing: true })
  return fse.pathExists(safePath)
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.ENSURE_PATH_EXISTS, async (event, pathValue: string): Promise<boolean> => {
  assertTrustedIpcSender(event)

  try {
    const safePath = await assertManagedPath(pathValue, "path", { allowMissing: true })
    await fse.ensureDir(safePath)
    return true
  } catch (err) {
    logMessage("error", "[back] [ipc] [ipc/handlers/pathsHandlers.ts] [ENSURE_PATH_EXISTS] Error ensuring path.")
    logMessage("debug", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [ENSURE_PATH_EXISTS] ${getErrorMessage(err)}`)
    return false
  }
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.OPEN_PATH_ON_FILE_EXPLORER, async (event, pathValue: string): Promise<void> => {
  assertTrustedIpcSender(event)
  shell.showItemInFolder(await assertManagedPath(pathValue, "path"))
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH, async (event, id: string, url: string, outputPath: string, fileName: string): Promise<string> => {
  assertTrustedIpcSender(event)
  const safeId = assertSafeTaskId(id)
  const safeUrl = assertAllowedDownloadUrl(url)
  const safeOutputPath = await assertManagedPath(outputPath, "output path", { allowMissing: true })
  const safeFileName = assertSafeFileName(fileName)
  const expectedMd5 = await getTrustedDownloadHash(safeUrl)

  logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [DOWNLOAD_ON_PATH] [${safeId}] Starting a bounded download.`)
  const downloadedPath = await runTrackedWorker(
    event,
    safeId,
    IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_PROGRESS,
    downloadWorkerPath,
    { id: safeId, url: safeUrl.toString(), outputPath: safeOutputPath, fileName: safeFileName, expectedMd5 },
    "DOWNLOAD_ON_PATH",
    (message) => {
      if (typeof message.path !== "string") throw new Error("Download returned an invalid path")
      return message.path
    }
  )
  if (expectedMd5) await recordVerifiedArtifact(downloadedPath, safeUrl, expectedMd5)
  return downloadedPath
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH, async (event, id: string, filePath: string, outputPath: string, deleteZip: boolean): Promise<boolean> => {
  assertTrustedIpcSender(event)
  const safeId = assertSafeTaskId(id)
  const safeFilePath = await assertManagedPath(filePath, "archive path")
  const safeOutputPath = await assertManagedPath(outputPath, "output path", { allowMissing: true })
  const shouldDeleteZip = assertBoolean(deleteZip, "delete archive flag")

  if (resolve(safeFilePath) === resolve(safeOutputPath)) throw new TypeError("Archive and output paths must differ")
  await validateArchive(safeFilePath)

  logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [EXTRACT_ON_PATH] [${safeId}] Starting a bounded extraction.`)
  await runTrackedWorker(
    event,
    safeId,
    IPC_CHANNELS.PATHS_MANAGER.EXTRACT_PROGRESS,
    extractWorker,
    { filePath: safeFilePath, outputPath: safeOutputPath, deleteZip: shouldDeleteZip, sevenZipBin },
    "EXTRACT_ON_PATH",
    () => true
  )
  return true
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER, async (event, id: string, filePath: string, outputPath: string, deleteInstaller: boolean): Promise<boolean> => {
  assertTrustedIpcSender(event)
  const safeId = assertSafeTaskId(id)
  const safeFilePath = await assertManagedPath(filePath, "installer path")
  const safeOutputPath = await assertManagedPath(outputPath, "output path", { allowMissing: true })
  const shouldDeleteInstaller = assertBoolean(deleteInstaller, "delete installer flag")

  if (process.platform !== "win32" || !(await fse.pathExists(safeFilePath))) return false

  const extension = extname(safeFilePath).toLowerCase()
  if (extension !== ".exe") throw new TypeError("Invalid installer file")
  await assertVerifiedArtifact(safeFilePath)

  return new Promise((resolvePromise) => {
    const exePath = safeFilePath
    let settled = false

    try {
      sendProgress(event, IPC_CHANNELS.PATHS_MANAGER.EXTRACT_PROGRESS, safeId, 0)
      const installer = spawn(exePath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/NOICONS", `/DIR=${safeOutputPath}`], { shell: false, windowsHide: true })

      const finish = (success: boolean): void => {
        if (settled) return
        settled = true
        if (shouldDeleteInstaller) void fse.remove(exePath).catch(() => {})
        if (success) sendProgress(event, IPC_CHANNELS.PATHS_MANAGER.EXTRACT_PROGRESS, safeId, 100)
        resolvePromise(success)
      }

      installer.on("error", (error) => {
        logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] Error launching installer.`)
        logMessage("debug", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] ${getErrorMessage(error)}`)
        finish(false)
      })
      installer.on("close", (code) => finish(code === 0))
    } catch (err) {
      logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] Installer setup failed.`)
      logMessage("debug", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] ${getErrorMessage(err)}`)
      resolvePromise(false)
    }
  })
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.COMPRESS_ON_PATH, async (event, id: string, inputPath: string, outputPath: string, outputFileName: string, compressionLevel = 4): Promise<boolean> => {
  assertTrustedIpcSender(event)
  const safeId = assertSafeTaskId(id)
  const safeInputPath = await assertManagedPath(inputPath, "input path")
  const safeOutputPath = await assertManagedPath(outputPath, "output path", { allowMissing: true })
  const safeOutputFileName = assertSafeFileName(outputFileName, "output file name")
  const safeCompressionLevel = assertInteger(compressionLevel, "compression level", 0, 9)

  logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [COMPRESS_ON_PATH] [${safeId}] Starting bounded compression.`)
  await runTrackedWorker(
    event,
    safeId,
    IPC_CHANNELS.PATHS_MANAGER.COMPRESS_PROGRESS,
    compressWorker,
    { inputPath: safeInputPath, outputPath: safeOutputPath, outputFileName: safeOutputFileName, compressionLevel: safeCompressionLevel, sevenZipBin },
    "COMPRESS_ON_PATH",
    () => true
  )
  return true
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.CHANGE_PERMS, async (event, paths: string[], perms: number): Promise<boolean> => {
  assertTrustedIpcSender(event)
  if (os.platform() !== "linux") return false
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 128) throw new TypeError("Invalid permissions paths")

  const safePaths = await Promise.all(paths.map((pathValue) => assertManagedPath(pathValue, "permissions path")))
  const safePerms = assertInteger(perms, "permissions", 0, 0o777)

  await runTrackedWorker(event, "permissions", undefined, changePermsWorker, { paths: safePaths, perms: safePerms }, "CHANGE_PERMS", () => true)
  return true
})

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.COPY_TO_ICONS, async (event, pathValue: string, name: string): Promise<{ status: true; file: string } | { status: false }> => {
  assertTrustedIpcSender(event)

  try {
    const safePath = await assertManagedPath(pathValue, "icon path")
    const safeName = assertSafeFileName(name, "icon name")
    if (extname(safePath).toLowerCase() !== ".png") throw new TypeError("Invalid icon file")

    const destinationDirectory = await assertManagedPath(join(app.getPath("userData"), "Icons"), "icons directory", { allowMissing: true })
    const file = `${safeName}.png`
    await fse.ensureDir(destinationDirectory)
    const safeDestinationDirectory = await assertManagedPath(destinationDirectory, "icons directory")
    const destinationPath = join(safeDestinationDirectory, basename(file))
    if (await fse.pathExists(destinationPath)) {
      const destinationStats = await fse.lstat(destinationPath)
      if (destinationStats.isSymbolicLink() || destinationStats.isDirectory()) throw new TypeError("Invalid icon destination")
    }
    await fse.copyFile(safePath, destinationPath)
    return { status: true, file }
  } catch {
    return { status: false }
  }
})
