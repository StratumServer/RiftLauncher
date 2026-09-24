import { ipcMain } from "electron"
import fse from "fs-extra"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"

import { getConfig, saveConfig } from "@src/config/configManager"
import { assertConfiguredInstallationPath, assertManagedDeletionPath, assertManagedPath } from "@src/ipc/pathPolicy"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { isInstallationPlaying, tryAcquireInstallationOperation } from "@src/ipc/installationActivity"
import { setShouldPreventClose } from "@src/utils/shouldPreventClose"
import { logMessage } from "@src/utils/logManager"
import { runCompression } from "@src/ipc/workers/compression"
import { extractTarGz } from "@src/ipc/workers/extraction"
import { validateWorldBackupArchive } from "@src/ipc/archiveValidation"
import { SAVES_FOLDER_NAME, WORLD_FILE_EXTENSION, canTransferWorld, collisionFreeWorldName, hasWorldSidecars, isSafeWorldName, listWorlds, worldVersionWarning } from "@domain/worlds/worlds"

const WORLD_BACKUPS_FOLDER = "Worlds"

type WorldOperationFailure =
  | "invalid-request"
  | "installation-not-found"
  | "installation-playing"
  | "saves-unavailable"
  | "world-not-found"
  | "world-busy"
  | "world-has-sidecars"
  | "archive-not-found"
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
        backupCount: (installation.worldBackups ?? []).filter((backup) => backup.worldName.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US")).length
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
  const name = names.find((candidate) => candidate === requestedName) ?? names.find((candidate) => candidate.toLocaleLowerCase("en-US") === requestedName.toLocaleLowerCase("en-US"))
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

function saveWorldBackupRecord(installationId: string, backup: WorldBackupType): Promise<boolean> {
  const write = worldBackupConfigWriteQueue.then(async () => {
    const currentConfig = await getConfig()
    const nextConfig = updateInstallation(currentConfig, installationId, (current) => ({ ...current, worldBackups: [backup, ...(current.worldBackups ?? [])] }))
    return saveConfig(nextConfig)
  })
  worldBackupConfigWriteQueue = write.then(
    () => undefined,
    () => undefined
  )
  return write
}

async function makeWorldBackup(installationId: unknown, requestedName: unknown): Promise<WorldBackupResult> {
  const checked = await checkedInstallation(installationId)
  if ("error" in checked) return checked.error
  const { config, installation, savesPath } = checked
  if (isInstallationPlaying(installation.id)) return failure("installation-playing")
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
        await runCompression({ inputPath: world.path, outputPath: outputFolder, outputFileName: `${backupId}.tar.gz`, compressionLevel: installation.compressionLevel })
        const backup: WorldBackupType = { id: backupId, date: Date.now(), path: archivePath, worldName: world.name }
        if (!(await saveWorldBackupRecord(installation.id, backup))) {
          await fse.remove(archivePath).catch(() => undefined)
          return failure("operation-failed")
        }
        return { ok: true, backup }
      } catch {
        await fse.remove(archivePath).catch(() => undefined)
        return failure("operation-failed")
      }
    })
  } catch {
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
        await validateWorldBackupArchive(backup.path, backup.worldName)
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
            logMessage("warn", "[back] [ipc] [ipc/handlers/worldsHandlers.ts] [RESTORE] Kept the replaced world aside after a successful restore.")
          })
        }
        return { ok: true as const }
      } catch {
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
  } catch {
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

ipcMain.handle(IPC_CHANNELS.WORLDS_MANAGER.RESTORE, async (event, installationId: unknown, backupId: unknown): Promise<WorldOperationResult> => {
  assertTrustedIpcSender(event)
  return restoreWorld(installationId, backupId)
})

ipcMain.handle(IPC_CHANNELS.WORLDS_MANAGER.TRANSFER, async (event, sourceId: unknown, worldName: unknown, targetId: unknown, mode: unknown): Promise<WorldTransferResult> => {
  assertTrustedIpcSender(event)
  return transferWorld(sourceId, worldName, targetId, mode)
})

logMessage("debug", "[back] [worlds] World management handlers registered.")
