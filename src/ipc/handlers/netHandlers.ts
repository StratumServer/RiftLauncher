import { ipcMain } from "electron"

import { IPC_CHANNELS } from "../ipcChannels"
import { readCatalogCache, writeCatalogCache } from "@src/ipc/catalogCache"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { requestBoundedText } from "@src/ipc/network"
import { assertAllowedApiUrl, getApiUrlMaxBytes } from "@src/ipc/validation"
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
