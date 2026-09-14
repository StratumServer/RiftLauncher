import { app, ipcMain } from "electron"
import fse from "fs-extra"
import { join } from "node:path"
import type { IpcMainInvokeEvent } from "electron"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { applyOptimumOverlay, restoreVanillaBuild } from "@src/ipc/optimumInstall"
import { getCachedOptimumManifest, getOptimumManifest, optimumCacheDirectory, optimumOverlayDirectory } from "@src/ipc/optimumManifest"
import { assertManagedPath } from "@src/ipc/pathPolicy"
import { assertSafeTaskId, assertString } from "@src/ipc/validation"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

const LOG_PREFIX = "[back] [ipc] [ipc/handlers/optimumHandlers.ts]"

function sendProgress(event: IpcMainInvokeEvent, id: string, progress: number): void {
  if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.OPTIMUM_MANAGER.PATCH_PROGRESS, { id, progress })
}

/**
 * Where the child's stderr goes.
 *
 * A `.txt` rather than a `.log`, deliberately: the repository's own `.gitignore`
 * carries a `*.log*` rule that has swallowed a file in a previous change. The
 * contents are never read back and never reach a log line, since everything the
 * CLI writes there is free text and absolute paths.
 */
function stderrLogPathFor(taskId: string): string {
  return join(app.getPath("userData"), "Logs", `optimum-patch-${taskId}.txt`)
}

/**
 * Whether Optimum can be offered this session, and where its overlay comes from.
 *
 * The answer is the session's manifest or one reason token, never an error: the
 * page shows a disabled choice with one calm line under it rather than a
 * failure, since no Optimum is a normal state and not a broken launcher.
 */
ipcMain.handle(IPC_CHANNELS.OPTIMUM_MANAGER.GET_MANIFEST, async (event): Promise<OptimumManifestResult> => {
  assertTrustedIpcSender(event)
  return getOptimumManifest()
})

/**
 * Patches one installed build with the overlay the renderer has just downloaded.
 *
 * The renderer names the folder and the version it has registered for it, and
 * nothing else: which archive, which hashes and which folder it is staged into
 * all come from the session manifest on this side. `assertManagedPath` covers
 * the game folder, and the contract establishes that the patch writes nothing
 * outside it, so that one check covers the whole child process.
 */
ipcMain.handle(IPC_CHANNELS.OPTIMUM_MANAGER.APPLY_OVERLAY, async (event, id: unknown, gameDirectory: unknown, gameVersion: unknown): Promise<OptimumPatchResult> => {
  assertTrustedIpcSender(event)
  const safeId = assertSafeTaskId(id)
  const safeGameDirectory = await assertManagedPath(gameDirectory, "game version path")
  const safeGameVersion = assertString(gameVersion, "game version", 128)

  const manifest = await getCachedOptimumManifest()
  if (!manifest) {
    logMessage("warn", `${LOG_PREFIX} [APPLY_OVERLAY] [${safeId}] No Optimum manifest was read this session.`)
    return { ok: false, reason: "manifest-unavailable" }
  }

  const overlayDirectory = await assertManagedPath(optimumOverlayDirectory(manifest), "overlay path", { allowMissing: true })
  const stderrLogPath = stderrLogPathFor(safeId)
  await fse.ensureDir(join(app.getPath("userData"), "Logs"))

  logMessage("info", `${LOG_PREFIX} [APPLY_OVERLAY] [${safeId}] Applying Optimum ${manifest.optimumVersion} to a registered build.`)
  sendProgress(event, safeId, 0)

  try {
    const result = await applyOptimumOverlay({
      manifest,
      archivePath: join(optimumCacheDirectory(), manifest.archive.filename),
      overlayDirectory,
      gameDirectory: safeGameDirectory,
      gameVersion: safeGameVersion,
      stderrLogPath,
      onProgress: (progress) => sendProgress(event, safeId, progress)
    })

    if (result.ok) logMessage("info", `${LOG_PREFIX} [APPLY_OVERLAY] [${safeId}] Applied Optimum ${manifest.optimumVersion}.`)
    else logMessage("error", `${LOG_PREFIX} [APPLY_OVERLAY] [${safeId}] Optimum was not applied: ${result.reason}.`)

    return result
  } catch (err) {
    logMessage("error", `${LOG_PREFIX} [APPLY_OVERLAY] [${safeId}] Optimum was not applied.`)
    logMessage("debug", `${LOG_PREFIX} [APPLY_OVERLAY] [${safeId}] ${getErrorMessage(err)}`)
    return { ok: false, reason: "engine-internal" }
  }
})

/**
 * Puts the four assemblies back out of the patch's own backup.
 *
 * Done here rather than by running the CLI with `--rollback`, which would need
 * the overlay still staged, a .NET runtime installed and, on a fresh session, a
 * download. Removing something the player already has should not depend on any
 * of those. What it restores is exactly what that flag restores.
 */
ipcMain.handle(IPC_CHANNELS.OPTIMUM_MANAGER.RESTORE_VANILLA, async (event, id: unknown, gameDirectory: unknown): Promise<OptimumPatchResult> => {
  assertTrustedIpcSender(event)
  const safeId = assertSafeTaskId(id)
  const safeGameDirectory = await assertManagedPath(gameDirectory, "game version path")

  logMessage("info", `${LOG_PREFIX} [RESTORE_VANILLA] [${safeId}] Restoring the vanilla assemblies of a registered build.`)
  sendProgress(event, safeId, 0)

  try {
    const result = await restoreVanillaBuild(safeGameDirectory)
    if (!result.ok) logMessage("error", `${LOG_PREFIX} [RESTORE_VANILLA] [${safeId}] The build was left as it was: ${result.reason}.`)
    return result
  } catch (err) {
    logMessage("error", `${LOG_PREFIX} [RESTORE_VANILLA] [${safeId}] The build was left as it was.`)
    logMessage("debug", `${LOG_PREFIX} [RESTORE_VANILLA] [${safeId}] ${getErrorMessage(err)}`)
    return { ok: false, reason: "restore-failed" }
  }
})
