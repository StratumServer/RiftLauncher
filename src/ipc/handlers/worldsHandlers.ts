import { ipcMain } from "electron"
import fse from "fs-extra"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"

import { getConfig, saveConfig } from "@src/config/configManager"
import { assertConfiguredInstallationPath, assertManagedDeletionPath, assertManagedPath } from "@src/ipc/pathPolicy"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { isInstallationPlaying, tryAcquireInstallationOperation } from "@src/ipc/installationActivity"
import { setShouldPreventClose } from "@src/utils/shouldPreventClose"
import { getErrorMessage, logMessage } from "@src/utils/logManager"
import { SAVES_FOLDER_NAME, WORLD_FILE_EXTENSION, canTransferWorld, collisionFreeWorldName, hasWorldSidecars, isSafeWorldName, listWorlds, worldVersionWarning } from "@domain/worlds/worlds"
import { deleteInstallationBackup } from "@domain/installations/backupDeletion"
import { pruneOldestBackups } from "@domain/installations/backup"

const WORLD_BACKUPS_FOLDER = "Worlds"
const LOG_PREFIX = "[back] [ipc] [ipc/handlers/worldsHandlers.ts]"

type WorldOperationFailure =
  | "invalid-request"
  | "installation-not-found"
  | "installation-playing"
  | "saves-unavailable"
  | "world-not-found"
  | "world-busy"
  | "world-has-sidecars"
  | "archive-not-found"
  | "backups-disabled"
  | "operation-failed"
type WorldOperationResult = { ok: true } | { ok: false; reason: WorldOperationFailure }
type WorldFailureResult = { ok: false; reason: WorldOperationFailure }

function failure(reason: WorldOperationFailure): { ok: false; reason: WorldOperationFailure } {
  return { ok: false, reason }
}

async function withCloseGuard<T>(description: string, operation: () => Promise<T>): Promise<T> {
  const token = randomUUID()
  setShouldPreventClose("add", token, description)
  try {
    return await operation()
  } finally {
    setShouldPreventClose("remove", token, description)
  }
}

function operationFailure(reason: "playing" | "busy"): WorldFailureResult {
  return failure(reason === "playing" ? "installation-playing" : "world-busy")
}

function findInstallation(config: ConfigType, installationId: unknown): InstallationType | undefined {
  if (typeof installationId !== "string" || installationId.length === 0 || installationId.length > 128 || installationId.includes("\0")) return undefined
  return config.installations.find((installation) => installation.id === installationId)
}

function worldPath(savesPath: string, worldName: string): string {
  return join(savesPath, worldName)
}

async function checkedInstallation(installationId: unknown): Promise<{ config: ConfigType; installation: InstallationType; savesPath: string } | { error: WorldFailureResult }> {
  const config = await getConfig()
  const installation = findInstallation(config, installationId)
  if (!installation) return { error: failure("installation-not-found") }

  try {
    const installationPath = await assertConfiguredInstallationPath(installation.path)
    const savesPath = await assertManagedPath(join(installationPath, SAVES_FOLDER_NAME), "worlds folder", { allowMissing: true })
    return { config, installation, savesPath }
  } catch {
    return { error: failure("operation-failed") }
  }
}

async function listWorldEntries(savesPath: string, installation: InstallationType): Promise<WorldListResult> {
  let names: string[]
  try {
    if (!(await fse.pathExists(savesPath))) return { ok: true, worlds: [] }
    names = await fse.readdir(savesPath)
  } catch {
    return { ok: false, reason: "saves-unavailable" }
  }

  const entries = []
  for (const name of names) {
    if (!isSafeWorldName(name)) continue
    try {
      const stats = await fse.lstat(join(savesPath, name))
      if (!stats.isFile() || stats.isSymbolicLink()) continue
      entries.push({
        name,
        size: stats.size,
        lastModified: stats.mtimeMs,
        isDefault: name.toLocaleLowerCase("en-US") === `default${WORLD_FILE_EXTENSION}`,
        backupCount: (installation.worldBackups ?? []).filter((backup) => backup.worldName === name).length
      })
    } catch {
      // A world can disappear while the player is looking at the list.
    }
  }
  return { ok: true, worlds: listWorlds(entries) }
}

async function findWorld(savesPath: string, requestedName: unknown): Promise<{ name: string; path: string; names: string[] } | null> {
  if (!isSafeWorldName(requestedName)) return null
  const names = await fse.readdir(savesPath).catch(() => [])
  // Exact only. Two siblings differing only by case can coexist on a case-sensitive
  // filesystem, and folding case here would let a delete or a restore reach the
  // wrong one (#465).
  const name = names.find((candidate) => candidate === requestedName)
  if (!name || !isSafeWorldName(name)) return null
  const path = worldPath(savesPath, name)
  const stats = await fse.lstat(path).catch(() => null)
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) return null
  return { name, path, names }
}

async function assertWorldWritable(world: { name: string; path: string; names: string[] }): Promise<boolean> {
  return !hasWorldSidecars(world.names, world.name)
}

function updateInstallation(config: ConfigType, installationId: string, update: (installation: InstallationType) => InstallationType): ConfigType {
  return { ...config, installations: config.installations.map((installation) => (installation.id === installationId ? update(installation) : installation)) }
}

let worldBackupConfigWriteQueue: Promise<void> = Promise.resolve()

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function removeWorldBackupArchive(archivePath: string, expectedBackupId: string): Promise<boolean> {
  if (typeof archivePath !== "string" || typeof expectedBackupId !== "string") return false
  if (!UUID_V4_REGEX.test(expectedBackupId)) return false
  const filename = basename(archivePath)
  if (filename !== `${expectedBackupId}.tar.gz`) return false
  if (basename(dirname(archivePath)) !== WORLD_BACKUPS_FOLDER) return false

  if (!(await fse.pathExists(archivePath))) return true

  try {
    const safePath = await assertManagedDeletionPath(archivePath)
    const safeFilename = basename(safePath)
    if (safeFilename !== `${expectedBackupId}.tar.gz`) return false
    if (basename(dirname(safePath)) !== WORLD_BACKUPS_FOLDER) return false
    if (basename(dirname(dirname(safePath))) === "Installations") return false

    const stat = await fse.lstat(safePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    await fse.remove(safePath)
    return !(await fse.pathExists(safePath))
  } catch {
    return false
  }
}

function addWorldBackupRecord(installationId: string, backup: WorldBackupType): Promise<boolean> {
  const write = worldBackupConfigWriteQueue.then(async () => {
    const currentConfig = await getConfig()
    const hasInstallation = currentConfig.installations.some((inst) => inst.id === installationId)
    if (!hasInstallation) return false

    const nextConfig = updateInstallation(currentConfig, installationId, (current) => ({
      ...current,
      worldBackups: [backup, ...(current.worldBackups ?? [])]
    }))
    return saveConfig(nextConfig)
  })
  worldBackupConfigWriteQueue = write.then(
    () => undefined,
    () => undefined
  )
  return write
}

function removeWorldBackupRecords(installationId: string, backupIds: Set<string>): Promise<boolean> {
  const write = worldBackupConfigWriteQueue.then(async () => {
    const currentConfig = await getConfig()
    const nextConfig = updateInstallation(currentConfig, installationId, (current) => ({
      ...current,
      worldBackups: (current.worldBackups ?? []).filter((candidate) => !backupIds.has(candidate.id))
    }))
    return saveConfig(nextConfig)
  })
  worldBackupConfigWriteQueue = write.then(
    () => undefined,
    () => undefined
  )
  return write
}

function removeWorldBackupRecord(installationId: string, backupId: string): Promise<boolean> {
  return removeWorldBackupRecords(installationId, new Set([backupId]))
}

async function makeWorldBackup(installationId: unknown, requestedName: unknown): Promise<WorldBackupResult> {
  const checked = await checkedInstallation(installationId)
  if ("error" in checked) return checked.error
  const { config, installation, savesPath } = checked
  if (isInstallationPlaying(installation.id)) return failure("installation-playing")
  if (installation.backupsLimit <= 0) return failure("backups-disabled")
  if (!(await fse.pathExists(savesPath))) return failure("saves-unavailable")
  const lease = tryAcquireInstallationOperation([installation.id])
  if (!lease.ok) return operationFailure(lease.reason)
  try {
    const world = await findWorld(savesPath, requestedName)
    if (!world) return failure("world-not-found")
    if (!(await assertWorldWritable(world))) return failure("world-has-sidecars")
    await assertManagedPath(world.path, "world")

    const backupId = randomUUID()
    const outputFolder = await assertManagedPath(join(config.backupsFolder, WORLD_BACKUPS_FOLDER), "world backup folder", { allowMissing: true })
    const archivePath = join(outputFolder, `${backupId}.tar.gz`)
    return await withCloseGuard("Backing up a world.", async () => {
      try {
        // Loaded here rather than at module scope: this chunk is tens of milliseconds of the
        // main process's startup, and it is only ever needed once a player asks for a backup or
        // a restore. Nothing else in this file touches it, so the require is off the boot path.
        const { runCompression } = await import("@src/ipc/workers/compression")
        await runCompression({ inputPath: world.path, outputPath: outputFolder, outputFileName: `${backupId}.tar.gz`, compressionLevel: installation.compressionLevel })
        const backup: WorldBackupType = { id: backupId, date: Date.now(), path: archivePath, worldName: world.name }
        const committed = await addWorldBackupRecord(installation.id, backup)
        if (!committed) {
          await fse.remove(archivePath).catch(() => undefined)
          return failure("operation-failed")
        }

        let deletedBackupIds: string[] = []
        try {
          const freshConfig = await getConfig()
          const freshInstallation = freshConfig.installations.find((inst) => inst.id === installation.id)
          const olderBackups = (freshInstallation?.worldBackups ?? []).filter((candidate) => candidate.worldName === world.name && candidate.id !== backup.id)
          const backupIdByPath = new Map(olderBackups.map((b) => [b.path, b.id]))
          const fileSystem = {
            exists: (path: string): Promise<boolean> => fse.pathExists(path),
            remove: (path: string): Promise<boolean> => {
              const expectedId = backupIdByPath.get(path)
              if (!expectedId) return Promise.resolve(false)
              return removeWorldBackupArchive(path, expectedId)
            }
          }
          const pruneOutcome = await pruneOldestBackups(fileSystem, {
            backups: olderBackups.map((b) => ({ id: b.id, date: b.date, path: b.path })),
            backupsLimit: installation.backupsLimit
          })
          if (pruneOutcome.deletedBackupIds.length > 0) {
            const deletedSet = new Set(pruneOutcome.deletedBackupIds)
            await removeWorldBackupRecords(installation.id, deletedSet)
            deletedBackupIds = pruneOutcome.deletedBackupIds
          }
        } catch (error) {
          logMessage("warn", `${LOG_PREFIX} [BACKUP] Pruning older world backups encountered an error.`)
          logMessage("debug", `${LOG_PREFIX} [BACKUP] ${getErrorMessage(error)}`)
        }

        return { ok: true, backup, deletedBackupIds }
      } catch (error) {
        await fse.remove(archivePath).catch(() => undefined)
        logMessage("warn", `${LOG_PREFIX} [BACKUP] Could not finish compressing or recording this world backup.`)
        logMessage("debug", `${LOG_PREFIX} [BACKUP] ${getErrorMessage(error)}`)
        return failure("operation-failed")
      }
    })
  } catch (error) {
    logMessage("warn", `${LOG_PREFIX} [BACKUP] Could not prepare this world backup.`)
    logMessage("debug", `${LOG_PREFIX} [BACKUP] ${getErrorMessage(error)}`)
    return failure("operation-failed")
  } finally {
    lease.release()
  }
}

async function deleteWorld(installationId: unknown, requestedName: unknown): Promise<WorldOperationResult> {
  const checked = await checkedInstallation(installationId)
  if ("error" in checked) return checked.error
  const { installation, savesPath } = checked
  if (isInstallationPlaying(installation.id)) return failure("installation-playing")
  const lease = tryAcquireInstallationOperation([installation.id])
  if (!lease.ok) return operationFailure(lease.reason)
  try {
    const world = await findWorld(savesPath, requestedName)
    if (!world) return failure("world-not-found")
    if (!(await assertWorldWritable(world))) return failure("world-has-sidecars")
    await assertManagedDeletionPath(world.path)
    try {
      await fse.remove(world.path)
      return { ok: true as const }
    } catch {
      return failure("operation-failed")
    }
  } catch {
    return failure("operation-failed")
  } finally {
    lease.release()
  }
}

async function restoreWorld(installationId: unknown, backupIdValue: unknown): Promise<WorldOperationResult> {
  const checked = await checkedInstallation(installationId)
  if ("error" in checked) return checked.error
  const { installation, savesPath } = checked
  if (isInstallationPlaying(installation.id)) return failure("installation-playing")
  if (typeof backupIdValue !== "string") return failure("invalid-request")
  const backup = (installation.worldBackups ?? []).find((candidate) => candidate.id === backupIdValue)
  if (!backup || !isSafeWorldName(backup.worldName)) return failure("archive-not-found")
  if (!(await fse.pathExists(backup.path))) return failure("archive-not-found")
  const lease = tryAcquireInstallationOperation([installation.id])
  if (!lease.ok) return operationFailure(lease.reason)
  try {
    const saveNames = await fse.readdir(savesPath).catch(() => [])
    if (hasWorldSidecars(saveNames, backup.worldName)) return failure("world-has-sidecars")
    const world = await findWorld(savesPath, backup.worldName)
    if (world && !(await assertWorldWritable(world))) return failure("world-has-sidecars")
    const result = await withCloseGuard("Restoring a world backup.", async () => {
      let tempRoot: string | null = null
      try {
        await fse.ensureDir(savesPath)
        tempRoot = await fse.mkdtemp(join(savesPath, ".rift-world-restore-"))
        await assertManagedPath(backup.path, "world backup")
        // Same reasoning as the two worker chunks above: nothing on the boot path reads an archive,
        // so the reader that opens one loads with the call that needs it.
        const { validateWorldBackupArchive } = await import("@src/ipc/archiveValidation")
        await validateWorldBackupArchive(backup.path, backup.worldName)
        const { extractTarGz } = await import("@src/ipc/workers/extraction")
        await extractTarGz(backup.path, tempRoot)
        const extracted = await fse.readdir(tempRoot)
        const files = []
        for (const name of extracted) {
          const stats = await fse.lstat(join(tempRoot, name))
          if (stats.isFile() && !stats.isSymbolicLink()) files.push(name)
          else throw new Error("unsafe world backup")
        }
        if (files.length !== 1 || !isSafeWorldName(files[0])) throw new Error("invalid world backup")
        await fse.ensureDir(savesPath)
        const target = world?.path ?? worldPath(savesPath, backup.worldName)
        await assertManagedPath(target, "restored world", { allowMissing: true })
        const staged = join(tempRoot, files[0])
        const replacement = `${target}.rift-replaced-${randomUUID()}`
        const existing = await fse.pathExists(target)
        if (existing) await fse.move(target, replacement)
        try {
          await fse.move(staged, target)
        } catch (error) {
          if (existing) await fse.move(replacement, target).catch(() => undefined)
          throw error
        }
        if (existing) {
          await fse.remove(replacement).catch(() => {
            logMessage("warn", `${LOG_PREFIX} [RESTORE] Kept the replaced world aside after a successful restore.`)
          })
        }
        return { ok: true as const }
      } catch (error) {
        logMessage("warn", `${LOG_PREFIX} [RESTORE] Could not finish restoring this world backup.`)
        logMessage("debug", `${LOG_PREFIX} [RESTORE] ${getErrorMessage(error)}`)
        return failure("operation-failed")
      } finally {
        if (tempRoot) await fse.remove(tempRoot).catch(() => undefined)
      }
    })
    return result as WorldOperationResult
  } finally {
    lease.release()
  }
}

async function transferWorld(sourceId: unknown, requestedName: unknown, targetId: unknown, modeValue: unknown): Promise<WorldTransferResult> {
  const config = await getConfig()
  const source = findInstallation(config, sourceId)
  const target = findInstallation(config, targetId)
  if (!source || !target) return failure("installation-not-found")
  if (!canTransferWorld(source.id, target.id)) return failure("invalid-request")
  if (modeValue !== "copy" && modeValue !== "move") return failure("invalid-request")
  if (isInstallationPlaying(source.id) || isInstallationPlaying(target.id)) return failure("installation-playing")
  if (!isSafeWorldName(requestedName)) return failure("world-not-found")

  try {
    const sourcePath = await assertConfiguredInstallationPath(source.path)
    const targetPath = await assertConfiguredInstallationPath(target.path)
    const sourceSaves = await assertManagedPath(join(sourcePath, SAVES_FOLDER_NAME), "source worlds folder")
    const targetSaves = await assertManagedPath(join(targetPath, SAVES_FOLDER_NAME), "destination worlds folder", { allowMissing: true })
    const lease = tryAcquireInstallationOperation([source.id, target.id])
    if (!lease.ok) return operationFailure(lease.reason)
    try {
      const world = await findWorld(sourceSaves, requestedName)
      if (!world) return failure("world-not-found")
      if (!(await assertWorldWritable(world))) return failure("world-has-sidecars")
      await assertManagedPath(world.path, "world")
      const names = await fse.readdir(targetSaves).catch(() => [])
      const targetName = collisionFreeWorldName(world.name, names.filter(isSafeWorldName))
      const warning = worldVersionWarning(source.version, target.version)
      await fse.ensureDir(targetSaves)
      const targetFile = worldPath(targetSaves, targetName)
      await assertManagedPath(targetFile, "destination world", { allowMissing: true })
      await fse.copyFile(world.path, targetFile, constants.COPYFILE_EXCL)
      if (modeValue === "move") {
        try {
          await fse.remove(world.path)
        } catch (error) {
          await fse.remove(targetFile).catch(() => undefined)
          throw error
        }
      }
      return { ok: true, targetWorldName: targetName, ...(warning ? { warning } : {}) }
    } finally {
      lease.release()
    }
  } catch (error) {
    logMessage("warn", `${LOG_PREFIX} [TRANSFER] Could not finish transferring this world.`)
    logMessage("debug", `${LOG_PREFIX} [TRANSFER] ${getErrorMessage(error)}`)
    return failure("operation-failed")
  }
}

ipcMain.handle(IPC_CHANNELS.WORLDS_MANAGER.LIST, async (event, installationId: unknown): Promise<WorldListResult> => {
  assertTrustedIpcSender(event)
  const checked = await checkedInstallation(installationId)
  if ("error" in checked) return checked.error as WorldListResult
  return listWorldEntries(checked.savesPath, checked.installation)
})

ipcMain.handle(IPC_CHANNELS.WORLDS_MANAGER.BACKUP, async (event, installationId: unknown, worldName: unknown): Promise<WorldBackupResult> => {
  assertTrustedIpcSender(event)
  return makeWorldBackup(installationId, worldName)
})

ipcMain.handle(IPC_CHANNELS.WORLDS_MANAGER.DELETE, async (event, installationId: unknown, worldName: unknown): Promise<WorldOperationResult> => {
  assertTrustedIpcSender(event)
  return deleteWorld(installationId, worldName)
})

async function deleteWorldBackup(installationId: unknown, backupIdValue: unknown): Promise<WorldOperationResult> {
  const checked = await checkedInstallation(installationId)
  if ("error" in checked) return checked.error
  const { installation } = checked
  if (isInstallationPlaying(installation.id)) return failure("installation-playing")
  if (typeof backupIdValue !== "string") return failure("invalid-request")
  const backup = (installation.worldBackups ?? []).find((candidate) => candidate.id === backupIdValue)
  if (!backup) return failure("archive-not-found")

  const lease = tryAcquireInstallationOperation([installation.id])
  if (!lease.ok) return operationFailure(lease.reason)

  try {
    const fileSystem = {
      exists: (path: string): Promise<boolean> => fse.pathExists(path),
      remove: async (path: string): Promise<boolean> => removeWorldBackupArchive(path, backup.id)
    }
    const result = await deleteInstallationBackup({ fileSystem }, { backup: { id: backup.id, path: backup.path, isDeleting: false, isRestoring: false } })
    if (!result.ok) return failure("operation-failed")

    const removed = await removeWorldBackupRecord(installation.id, backup.id)
    if (!removed) return failure("operation-failed")

    return { ok: true }
  } finally {
    lease.release()
  }
}

ipcMain.handle(IPC_CHANNELS.WORLDS_MANAGER.DELETE_BACKUP, async (event, installationId: unknown, backupId: unknown): Promise<WorldOperationResult> => {
  assertTrustedIpcSender(event)
  return deleteWorldBackup(installationId, backupId)
})

ipcMain.handle(IPC_CHANNELS.WORLDS_MANAGER.RESTORE, async (event, installationId: unknown, backupId: unknown): Promise<WorldOperationResult> => {
  assertTrustedIpcSender(event)
  return restoreWorld(installationId, backupId)
})

ipcMain.handle(IPC_CHANNELS.WORLDS_MANAGER.TRANSFER, async (event, sourceId: unknown, worldName: unknown, targetId: unknown, mode: unknown): Promise<WorldTransferResult> => {
  assertTrustedIpcSender(event)
  return transferWorld(sourceId, worldName, targetId, mode)
})
