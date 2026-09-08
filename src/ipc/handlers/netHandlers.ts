import { app, ipcMain } from "electron"

import { IPC_CHANNELS } from "../ipcChannels"
import { readCatalogCache, writeCatalogCache } from "@src/ipc/catalogCache"
import { ConcurrencyLimiter } from "@domain/concurrencyLimiter"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { requestBoundedBuffer, requestBoundedText } from "@src/ipc/network"
import { assertAllowedApiUrl, assertAllowedDownloadUrl, getApiUrlMaxBytes, MAX_MODDB_LISTING_RESPONSE_BYTES } from "@src/ipc/validation"
import { newestReleaseFileId, parseModDetailResponse } from "@domain/mods/moddb"
import { MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl, MODDB_VISIBILITY_ACCEPTED, MODDB_VISIBILITY_UNASKED } from "@domain/moddbVisibility"
import { getConfig, saveConfig } from "@src/config/configManager"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

const MOD_CATALOG_HOSTNAME = "mods.vintagestory.at"
const MOD_CATALOG_PATHNAME = "/api/mods"

function isModCatalogUrl(url: URL): boolean {
  return url.hostname === MOD_CATALOG_HOSTNAME && url.pathname === MOD_CATALOG_PATHNAME
}

/**
 * Nothing capped how many QUERY_URL calls the renderer could have in flight at once, so a
 * burst of mod-detail lookups went straight out as one request per mod with no ceiling.
 * The modpack import is the loudest caller: it resolves every entry the folder does not
 * already satisfy, and it now does that when the manifest loads instead of when Import is
 * clicked, so a 200-mod pack opened 200 sockets at the mod database before the player had
 * decided anything. Manage Mods does the same shape of thing, one detail per installed mod.
 *
 * The bound belongs here rather than in the popup because every caller of this channel
 * shares the one remote host, and only the main process sees all of them at once. A queued
 * call looks to the renderer exactly like a slow one, a promise that has not settled, which
 * is what the popup's "Checking the mod database..." state already renders.
 *
 * 6 is the per-host connection cap Chrome and Firefox have used for years, so a burst from
 * the launcher never puts more on the mod database, which is community-run on modest
 * hosting, than an ordinary visit to one of its pages does. It also keeps a big pack quick:
 * 200 lookups in lanes of 6 is 34 rounds, a few seconds at a normal response time, rather
 * than the minutes a smaller bound would cost.
 *
 * Queueing cannot trip a request's own timeout: requestBoundedText starts its wall clock
 * inside the task, which the limiter does not run until a slot is free.
 */
const QUERY_URL_CONCURRENCY_LIMIT = 6

const queryConcurrency = new ConcurrencyLimiter(QUERY_URL_CONCURRENCY_LIMIT)

// Same reason pathsHandlers.ts shuts its limiters down here: before-quit can preventDefault
// (the config flush in main/index.ts), so a queued lookup could otherwise still be handed a
// slot and start a fresh request while the app is on its way out.
app.on("before-quit", () => {
  queryConcurrency.shutdown()
})

/**
 * Validates and fetches a bounded API response, applying the per-rule ceiling (see
 * API_URL_RULES) and taking a slot in {@link queryConcurrency} for the request itself. The mods-catalog endpoint additionally serves its last good disk-cached
 * response, with a logged warning, when the fresh fetch fails for any reason (network
 * down, ceiling tripped, non-2xx status). Every other endpoint fails as before.
 */
export async function queryUrl(url: unknown): Promise<string> {
  const safeUrl = assertAllowedApiUrl(url)
  const maxBytes = getApiUrlMaxBytes(safeUrl)
  const isCatalog = isModCatalogUrl(safeUrl)

  try {
    const text = await queryConcurrency.run(() => requestBoundedText(safeUrl, { maxBytes }))
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
 * Only ever reached through {@link acceptModDbVisibility}, which means only from an explicit click
 * on the prompt and only once the acceptance is on disk. Nothing calls it at startup, on update, or
 * on any schedule.
 *
 * Everything it can go wrong on is swallowed: an unreachable API, a listing with no readable
 * release, a refused download, a redirect (`requestBoundedBuffer` follows none, and the counter has
 * already been incremented by the time the site issues one, so the CDN bytes are never even
 * transferred). This is a courtesy the player offered, not a task they are waiting on, so a failure
 * is logged at debug and forgotten rather than retried or reported.
 *
 * The two requests get a `try` each rather than sharing one, so which of them failed is never in
 * doubt. Only the second can be a counted outcome: the first runs before any file id exists, and a
 * redirect out of it means the API moved, not that anything was registered.
 */
export async function fetchModDbListingArchive(): Promise<void> {
  if (listingArchiveRequested) return
  listingArchiveRequested = true

  let fileId: number | undefined

  try {
    const detailUrl = assertAllowedApiUrl(MODDB_LISTING_DETAIL_URL)
    const detail = parseModDetailResponse(await requestBoundedText(detailUrl, { maxBytes: getApiUrlMaxBytes(detailUrl) }))
    if (detail.ok) fileId = newestReleaseFileId(detail.payload)
  } catch (err) {
    logMessage("debug", `[back] [ipc] [ipc/handlers/netHandlers.ts] [ACCEPT_MODDB_VISIBILITY] ${getErrorMessage(err)}`)
  }

  if (fileId === undefined) return

  try {
    await requestBoundedBuffer(assertAllowedDownloadUrl(moddbListingDownloadUrl(fileId)), { maxBytes: MAX_MODDB_LISTING_RESPONSE_BYTES })
  } catch (err) {
    const message = getErrorMessage(err)

    // ModDB answers the counting endpoint with a 302 to its CDN, and the bounded network layer
    // refuses to follow redirects, so this rejection is what a counted request looks like from
    // here rather than a failure. Reading the message is the only signal available; if Electron
    // ever rewords it the request still behaves exactly the same and only this line falls back
    // to the branch below.
    if (message.toLowerCase().includes("redirect")) {
      logMessage(
        "debug",
        "[back] [ipc] [ipc/handlers/netHandlers.ts] [ACCEPT_MODDB_VISIBILITY] The listing download endpoint answered with its redirect, which is the counted outcome. Not followed on purpose."
      )
      return
    }

    logMessage("debug", `[back] [ipc] [ipc/handlers/netHandlers.ts] [ACCEPT_MODDB_VISIBILITY] ${message}`)
  }
}

/**
 * Writes the accepted answer to the config, and only then makes the one courtesy request.
 *
 * The order is the whole point. The answer on disk is the ledger that says this player has had
 * their one chance, so nothing may be requested until that ledger entry is durable: a crash, or a
 * disk that refuses the write, between the request and the write would leave the counter
 * incremented and the question still unanswered, and the next launch would ask and count again.
 *
 * Owned by the main process for the same reason. The renderer's config saves are coalesced and
 * fire-and-forget, which is right for a window size and wrong for a one-per-player promise.
 *
 * Answers whether the acceptance is on disk. False means nothing was requested and nothing was
 * recorded, so the question comes back next launch, which is the honest outcome: no count was
 * registered either. A config that already carries any answer is refused outright, since the one
 * chance was spent on this launch or an earlier one.
 *
 * The reverse loss, a write that lands and a crash before the request, costs the listing one
 * uncounted download. That direction is the acceptable one: the promise is one count per player at
 * most, not at least.
 */
export async function acceptModDbVisibility(): Promise<boolean> {
  const config = await getConfig()
  if (config.moddbVisibilityAnswer !== MODDB_VISIBILITY_UNASKED) return false
  if (!(await saveConfig({ ...config, moddbVisibilityAnswer: MODDB_VISIBILITY_ACCEPTED }))) return false

  await fetchModDbListingArchive()
  return true
}

ipcMain.handle(IPC_CHANNELS.NET_MANAGER.ACCEPT_MODDB_VISIBILITY, async (event): Promise<boolean> => {
  assertTrustedIpcSender(event)
  return await acceptModDbVisibility()
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
