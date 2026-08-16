import { ipcMain, app, shell } from "electron"
import { path7za } from "7zip-bin"
import fse from "fs-extra"
import { basename, extname, join, resolve, sep } from "path"
import os from "os"
import { spawn } from "child_process"
import type { IpcMainInvokeEvent } from "electron"

import { logMessage, getErrorMessage } from "@src/utils/logManager"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { createTrackedWorker, disposeTrackedWorker } from "@src/ipc/workerManager"
import { validateArchive } from "@src/ipc/archiveValidation"
import { assertAllowedDownloadUrl, assertBoolean, assertInteger, assertPath, assertSafeFileName, assertSafeTaskId, isRecord } from "@src/ipc/validation"
import { assertManagedDeletionPath, assertManagedPath } from "@src/ipc/pathPolicy"
import { assertVerifiedArtifact, getTrustedDownloadHash, recordVerifiedArtifact } from "@src/ipc/artifactVerification"
import { attemptInstallerTreeKill, extractionOutcomeToResult, installerMissingResult, notWindowsResult, spawnInstallerOutcomeToResult } from "@src/ipc/handlers/installerTimeoutOutcome"

import compressWorker from "@src/ipc/workers/compressWorker?modulePath"
import extractWorker from "@src/ipc/workers/extractWorker?modulePath"
import innoExtractWorker from "@src/ipc/workers/innoExtractWorker?modulePath"
import changePermsWorker from "@src/ipc/workers/changePermsWorker?modulePath"
import downloadWorkerPath from "@src/ipc/workers/downloadWorker?modulePath"

const sevenZipBin = app.isPackaged ? path7za.replace("app.asar", "app.asar.unpacked") : path7za
const WORKER_TIMEOUTS_MS: Record<string, number> = {
  DOWNLOAD_ON_PATH: 45 * 60 * 1_000,
  EXTRACT_ON_PATH: 30 * 60 * 1_000,
  COMPRESS_ON_PATH: 30 * 60 * 1_000,
  CHANGE_PERMS: 10 * 60 * 1_000,
  // Reading the payload out of the Windows installer. Measured at 41 seconds
  // for the 598 MB installer of 1.22.6 on a developer machine, so this leaves
  // room for a slow disk without leaving a stuck worker running for an hour.
  RUN_INSTALLER: 30 * 60 * 1_000
}

/**
 * Whether a Windows install reads the game out of the installer instead of
 * running it.
 *
 * Running it is what issue #8 is about: a pre-existing uninstall key makes
 * `InitializeSetup` show a MsgBox that `/SUPPRESSMSGBOXES` cannot answer, the
 * silent run hangs on it, and every run writes that key back for the next
 * install to trip over. Reading the payload plays none of the script, so the
 * dialog, the registry write and the redirect all stop existing at once.
 *
 * The constant is here so the conformance workflow can exercise both paths
 * against a real machine later. It stays true: the extraction is what a player
 * gets, and the installer is only run for a file the reader declines.
 */
const EXTRACT_INSTALLER_PAYLOAD = true

/**
 * RUN_INSTALLER spawns a real installer process directly rather than going
 * through a tracked worker, so it sits outside WORKER_TIMEOUTS_MS above; this
 * bound mirrors that table's spirit (generous but finite) instead of joining
 * its shape. 15 minutes covers the silent Inno installer plus a bundled
 * runtime sub-installer under normal conditions (the .NET 7 Desktop Runtime
 * that 1.18.15 pulls in), while still failing a genuinely hung sub-installer
 * well inside a CI job's ceiling. Issue #55: on a clean windows-latest
 * runner that sub-installer hung outright, and the job died at its 30-minute
 * ceiling with the installer still alive as an orphan because RUN_INSTALLER
 * had no bound of its own.
 */
const RUN_INSTALLER_TIMEOUT_MS = 15 * 60 * 1_000

type WorkerMessage = {
  type: unknown
  progress?: unknown
  path?: unknown
  message?: unknown
  verdict?: unknown
  reason?: unknown
  filesWritten?: unknown
  bytesWritten?: unknown
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

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.MOVE_PATH, async (event, fromPath: string, toPath: string): Promise<boolean> => {
  assertTrustedIpcSender(event)

  try {
    // The source disappears, so it goes through the deletion grade assertion.
    const safeFromPath = await assertManagedDeletionPath(fromPath)
    const safeToPath = await assertManagedPath(toPath, "destination path", { allowMissing: true })

    if (safeFromPath === safeToPath) throw new TypeError("Source and destination paths must differ")
    if (await fse.pathExists(safeToPath)) throw new TypeError("Destination path already exists")

    logMessage("info", "[back] [ipc] [ipc/handlers/pathsHandlers.ts] [MOVE_PATH] Moving an approved path.")
    await fse.move(safeFromPath, safeToPath)
    return true
  } catch (err) {
    logMessage("error", "[back] [ipc] [ipc/handlers/pathsHandlers.ts] [MOVE_PATH] Error moving path.")
    logMessage("debug", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [MOVE_PATH] ${getErrorMessage(err)}`)
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
  await validateArchive(safeFilePath, sevenZipBin)

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

ipcMain.handle(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER, async (event, id: string, filePath: string, outputPath: string, deleteInstaller: boolean): Promise<InstallerRunResult> => {
  assertTrustedIpcSender(event)
  const safeId = assertSafeTaskId(id)
  const safeFilePath = await assertManagedPath(filePath, "installer path")
  const safeOutputPath = await assertManagedPath(outputPath, "output path", { allowMissing: true })
  const shouldDeleteInstaller = assertBoolean(deleteInstaller, "delete installer flag")

  if (process.platform !== "win32") return notWindowsResult()
  if (!(await fse.pathExists(safeFilePath))) return installerMissingResult()

  const extension = extname(safeFilePath).toLowerCase()
  if (extension !== ".exe") throw new TypeError("Invalid installer file")
  await assertVerifiedArtifact(safeFilePath)

  if (EXTRACT_INSTALLER_PAYLOAD) {
    const verdict = await extractInstallerPayload(event, safeId, safeFilePath, safeOutputPath, shouldDeleteInstaller)
    if (verdict !== "format-refused") return extractionOutcomeToResult(verdict)
  }

  return spawnInstaller(event, safeId, safeFilePath, safeOutputPath, shouldDeleteInstaller)
})

/**
 * Reads the game out of the installer instead of running it.
 *
 * @returns `extracted` or `failed` once the attempt is over, or `format-refused`
 * when the reader declined the file and the caller should run the installer.
 */
async function extractInstallerPayload(
  event: IpcMainInvokeEvent,
  safeId: string,
  safeFilePath: string,
  safeOutputPath: string,
  shouldDeleteInstaller: boolean
): Promise<"extracted" | "failed" | "format-refused"> {
  logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] Extracting the installer payload instead of running it.`)
  sendProgress(event, IPC_CHANNELS.PATHS_MANAGER.EXTRACT_PROGRESS, safeId, 0)

  try {
    return await runTrackedWorker(
      event,
      safeId,
      IPC_CHANNELS.PATHS_MANAGER.EXTRACT_PROGRESS,
      innoExtractWorker,
      { filePath: safeFilePath, outputPath: safeOutputPath, deleteInstaller: shouldDeleteInstaller },
      "RUN_INSTALLER",
      (message) => {
        if (message.verdict === "format-refused") {
          const reason = typeof message.reason === "string" ? message.reason : "no reason given"
          logMessage("warn", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] The installer format was refused, falling back to running it. reason=${reason}`)
          return "format-refused"
        }
        if (message.verdict !== "extracted") throw new Error("Installer payload extraction returned an unknown verdict")
        logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] Extracted ${message.filesWritten} files, ${message.bytesWritten} bytes.`)
        return "extracted"
      }
    )
  } catch (err) {
    logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] Installer payload extraction failed.`)
    logMessage("debug", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] ${getErrorMessage(err)}`)
    return "failed"
  }
}

/**
 * The original path: run the installer silently and hope no dialog is waiting.
 *
 * Kept for the file this reader cannot follow. Issue #8 is exactly what happens
 * here when the uninstall key is already set, so this is the fallback and not
 * the way in.
 */
function spawnInstaller(event: IpcMainInvokeEvent, safeId: string, safeFilePath: string, safeOutputPath: string, shouldDeleteInstaller: boolean): Promise<InstallerRunResult> {
  return new Promise((resolvePromise) => {
    const exePath = safeFilePath
    let settled = false

    try {
      sendProgress(event, IPC_CHANNELS.PATHS_MANAGER.EXTRACT_PROGRESS, safeId, 0)
      const installer = spawn(exePath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/NOICONS", `/DIR=${safeOutputPath}`], { shell: false, windowsHide: true })

      const timeoutHandle = setTimeout(() => {
        logMessage(
          "error",
          `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] Timed out after ${RUN_INSTALLER_TIMEOUT_MS}ms waiting on the installer; killing its process tree. reason=installer-timed-out`
        )
        attemptInstallerTreeKill(
          installer.pid,
          process.platform,
          (command, args) => spawn(command, args, { shell: false, windowsHide: true }),
          (level, message) => logMessage(level, `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] ${message}`)
        )
        finish("timed-out")
      }, RUN_INSTALLER_TIMEOUT_MS)

      const finish = (outcome: "installed" | "timed-out" | "failed"): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutHandle)
        if (shouldDeleteInstaller) void fse.remove(exePath).catch(() => {})
        if (outcome === "installed") sendProgress(event, IPC_CHANNELS.PATHS_MANAGER.EXTRACT_PROGRESS, safeId, 100)
        resolvePromise(spawnInstallerOutcomeToResult(outcome))
      }

      installer.on("error", (error) => {
        logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] Error launching installer.`)
        logMessage("debug", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] ${getErrorMessage(error)}`)
        finish("failed")
      })
      installer.on("close", (code) => finish(code === 0 ? "installed" : "failed"))
    } catch (err) {
      logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] Installer setup failed.`)
      logMessage("debug", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [RUN_INSTALLER] [${safeId}] ${getErrorMessage(err)}`)
      resolvePromise(spawnInstallerOutcomeToResult("failed"))
    }
  })
}

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
