import { app, ipcMain } from "electron"
import fse from "fs-extra"
import { createHash } from "node:crypto"
import { extname, join } from "node:path"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { requestBoundedBuffer } from "@src/ipc/network"
import { assertManagedPath } from "@src/ipc/pathPolicy"
import { assertAllowedApiUrl, assertPath, getApiUrlMaxBytes, MAX_BACKGROUND_IMAGE_BYTES } from "@src/ipc/validation"
import { backgroundCacheFileName, backgroundImageUrl, CUSTOM_BACKGROUND_ID, isBackgroundFileName, isBackgroundSha256, isCatalogBackgroundId, isJpegBytes } from "@domain/backgrounds"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

const LOG_PREFIX = "[back] [ipc] [ipc/handlers/backgroundHandlers.ts]"

function backgroundsDirectory(): string {
  return join(app.getPath("userData"), "Cache", "Backgrounds")
}

function backgroundPath(id: string): string {
  return join(backgroundsDirectory(), backgroundCacheFileName(id))
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function isCurrentCachedBackground(id: string, expectedSha256: string | undefined): Promise<boolean> {
  const destination = backgroundPath(id)
  if (!(await fse.pathExists(destination))) return false

  const stats = await fse.lstat(destination)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError("Invalid background destination")
  if (expectedSha256 === undefined) return true
  if (stats.size > MAX_BACKGROUND_IMAGE_BYTES) return false

  return sha256(await fse.readFile(destination)) === expectedSha256
}

/**
 * Writes one background into the cache.
 *
 * The destination is refused rather than overwritten when something that is not a plain file is
 * sitting on the name, so a symlink planted there cannot turn a cache write into a write anywhere
 * else on disk. Overwriting a real file is the point: the custom slot keeps one name.
 */
async function writeBackground(id: string, bytes: Buffer): Promise<void> {
  await fse.ensureDir(backgroundsDirectory())
  const destination = backgroundPath(id)

  if (await fse.pathExists(destination)) {
    const stats = await fse.lstat(destination)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError("Invalid background destination")
  }

  await fse.writeFile(destination, bytes)
}

/**
 * Downloads one catalog scene into the cache when it is missing or its manifest hash changed.
 *
 * Called when the player picks a scene, and again for the scene already selected each time the
 * settings section is opened, which is what quietly repairs a cache someone emptied by hand.
 */
ipcMain.handle(IPC_CHANNELS.BACKGROUNDS_MANAGER.ENSURE_BACKGROUND, async (event, id: unknown, file: unknown, expectedSha256: unknown): Promise<{ refreshed: boolean }> => {
  assertTrustedIpcSender(event)

  try {
    if (!isCatalogBackgroundId(id) || !isBackgroundFileName(file)) throw new TypeError("Invalid background")
    if (expectedSha256 !== undefined && !isBackgroundSha256(expectedSha256)) throw new TypeError("Invalid background hash")
    const expectedHash = typeof expectedSha256 === "string" ? expectedSha256.toLowerCase() : undefined
    if (await isCurrentCachedBackground(id, expectedHash)) return { refreshed: false }

    const url = assertAllowedApiUrl(backgroundImageUrl(file))
    const bytes = await requestBoundedBuffer(url, { maxBytes: getApiUrlMaxBytes(url), accept: "image/jpeg" })
    if (!isJpegBytes(bytes)) throw new TypeError("Downloaded background is not a JPEG")
    if (expectedHash !== undefined && sha256(bytes) !== expectedHash) throw new TypeError("Downloaded background hash mismatch")

    await writeBackground(id, bytes)
    return { refreshed: true }
  } catch (err) {
    logMessage("warn", `${LOG_PREFIX} [ENSURE_BACKGROUND] Could not cache the background.`)
    logMessage("debug", `${LOG_PREFIX} [ENSURE_BACKGROUND] ${getErrorMessage(err)}`)
    return { refreshed: false }
  }
})

/**
 * Copies the picture the player picked into the same cache, under the reserved custom name.
 *
 * Known limit: JPEG only, which is what the extension gate on the `background:` protocol serves and
 * what the catalog itself is. The same shape the custom installation icons flow has always had
 * (PNG only, see COPY_TO_ICONS). If players turn up with PNG screenshots, the change is a second
 * cached name and a Content-Type chosen from the sniffed bytes, not a decoder.
 */
ipcMain.handle(IPC_CHANNELS.BACKGROUNDS_MANAGER.COPY_CUSTOM_BACKGROUND, async (event, pathValue: unknown): Promise<boolean> => {
  assertTrustedIpcSender(event)

  try {
    const safePath = await assertManagedPath(assertPath(pathValue, "background path"), "background path")
    if (![".jpg", ".jpeg"].includes(extname(safePath).toLowerCase())) throw new TypeError("Invalid background file")

    const stats = await fse.lstat(safePath)
    // Checked before the read, not after: the cap is there so a huge file is refused rather than
    // pulled into memory first. Same ceiling the download side gets from the URL rule.
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_BACKGROUND_IMAGE_BYTES) throw new TypeError("Invalid background file")

    const bytes = await fse.readFile(safePath)
    if (!isJpegBytes(bytes)) throw new TypeError("Picked background is not a JPEG")

    await writeBackground(CUSTOM_BACKGROUND_ID, bytes)
    return true
  } catch (err) {
    logMessage("warn", `${LOG_PREFIX} [COPY_CUSTOM_BACKGROUND] Could not copy the picked background.`)
    logMessage("debug", `${LOG_PREFIX} [COPY_CUSTOM_BACKGROUND] ${getErrorMessage(err)}`)
    return false
  }
})
