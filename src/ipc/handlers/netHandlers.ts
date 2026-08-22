import { ipcMain } from "electron"

import { IPC_CHANNELS } from "../ipcChannels"
import { readCatalogCache, writeCatalogCache } from "@src/ipc/catalogCache"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { requestBoundedBuffer, requestBoundedText } from "@src/ipc/network"
import { assertAllowedApiUrl, assertAllowedDownloadUrl, getApiUrlMaxBytes, MAX_MODDB_LISTING_RESPONSE_BYTES } from "@src/ipc/validation"
import { newestReleaseFileId, parseModDetailResponse } from "@domain/mods/moddb"
import { MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl } from "@domain/moddbVisibility"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

const MOD_CATALOG_HOSTNAME = "mods.vintagestory.at"
const MOD_CATALOG_PATHNAME = "/api/mods"

function isModCatalogUrl(url: URL): boolean {
  return url.hostname === MOD_CATALOG_HOSTNAME && url.pathname === MOD_CATALOG_PATHNAME
}

/**
 * Validates and fetches a bounded API response, applying the per-rule ceiling (see
 * API_URL_RULES). The mods-catalog endpoint additionally serves its last good disk-cached
 * response, with a logged warning, when the fresh fetch fails for any reason (network
 * down, ceiling tripped, non-2xx status). Every other endpoint fails as before.
 */
export async function queryUrl(url: unknown): Promise<string> {
  const safeUrl = assertAllowedApiUrl(url)
  const maxBytes = getApiUrlMaxBytes(safeUrl)
  const isCatalog = isModCatalogUrl(safeUrl)

  try {
    const text = await requestBoundedText(safeUrl, { maxBytes })
    if (isCatalog) {
      await writeCatalogCache(safeUrl, text).catch((cacheErr: unknown) => {
        logMessage("debug", `[back] [ipc] [ipc/handlers/netHandlers.ts] [QUERY_URL] Failed to write mod catalog cache: ${getErrorMessage(cacheErr)}`)
      })
    }
    return text
  } catch (err) {
    if (isCatalog) {
      const cached = await readCatalogCache(safeUrl)
      if (cached !== null) {
        logMessage("warn", "[back] [ipc] [ipc/handlers/netHandlers.ts] [QUERY_URL] Mod catalog fetch failed, serving last good cached response.")
        logMessage("debug", `[back] [ipc] [ipc/handlers/netHandlers.ts] [QUERY_URL] ${getErrorMessage(err)}`)
        return cached
      }
    }
    throw err
  }
}

/**
 * Whether this process has already made the courtesy request. Guards a double click on a prompt
 * that is only meant to be answerable once; the config answer is what stops it happening on any
 * later launch. Never reset: one increment per player, ever (#219).
 */
let listingArchiveRequested = false

/**
 * Fetches the launcher's own ModDB listing archive once, which is what registers a download
 * against that listing (see src/domain/moddbVisibility.ts for why it is the only URL that counts).
 *
 * Only ever reached from an explicit click on the prompt, and only from the "count me in" answer.
 * Nothing calls it at startup, on update, or on any schedule.
 *
 * Everything it can go wrong on is swallowed: an unreachable API, a listing with no readable
 * release, a refused download, a redirect (`requestBoundedBuffer` follows none, and the counter has
 * already been incremented by the time the site issues one, so the CDN bytes are never even
 * transferred). This is a courtesy the player offered, not a task they are waiting on, so a failure
 * is logged at debug and forgotten rather than retried or reported.
 */
export async function fetchModDbListingArchive(): Promise<void> {
  if (listingArchiveRequested) return
  listingArchiveRequested = true

  try {
    const detailUrl = assertAllowedApiUrl(MODDB_LISTING_DETAIL_URL)
    const detail = parseModDetailResponse(await requestBoundedText(detailUrl, { maxBytes: getApiUrlMaxBytes(detailUrl) }))
    if (!detail.ok) return

    const fileId = newestReleaseFileId(detail.payload)
    if (fileId === undefined) return

    await requestBoundedBuffer(assertAllowedDownloadUrl(moddbListingDownloadUrl(fileId)), { maxBytes: MAX_MODDB_LISTING_RESPONSE_BYTES })
  } catch (err) {
    logMessage("debug", `[back] [ipc] [ipc/handlers/netHandlers.ts] [FETCH_MODDB_LISTING_ARCHIVE] ${getErrorMessage(err)}`)
  }
}

ipcMain.handle(IPC_CHANNELS.NET_MANAGER.FETCH_MODDB_LISTING_ARCHIVE, async (event): Promise<void> => {
  assertTrustedIpcSender(event)
  await fetchModDbListingArchive()
})

ipcMain.handle(IPC_CHANNELS.NET_MANAGER.QUERY_URL, async (event, url: unknown): Promise<string> => {
  assertTrustedIpcSender(event)

  try {
    return await queryUrl(url)
  } catch (err) {
    logMessage("error", "[back] [ipc] [ipc/handlers/netHandlers.ts] [QUERY_URL] Network request failed.")
    logMessage("debug", `[back] [ipc] [ipc/handlers/netHandlers.ts] [QUERY_URL] ${getErrorMessage(err)}`)
    throw err
  }
})
