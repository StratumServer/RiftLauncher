import { app, ipcMain } from "electron"

import { IPC_CHANNELS } from "../ipcChannels"
import { readCatalogCache, writeCatalogCache } from "@src/ipc/catalogCache"
import { ConcurrencyLimiter } from "@domain/concurrencyLimiter"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { BoundedResponseError, requestBoundedBuffer, requestBoundedText } from "@src/ipc/network"
import { assertAllowedApiUrl, assertAllowedDownloadUrl, getApiUrlMaxBytes, isRecord, MAX_MODDB_LISTING_RESPONSE_BYTES } from "@src/ipc/validation"
import { parseModDetailResponse, releaseFileIdForVersion } from "@domain/mods/moddb"
import {
  answerModDbVisibility,
  MODDB_LISTING_DETAIL_URL,
  moddbLaunchAction,
  moddbListingDownloadUrl,
  moddbListingVersion,
  MODDB_VISIBILITY_ALWAYS,
  MODDB_VISIBILITY_ONCE,
  rememberCountedVersion,
  type ModDbVisibilityConsent
} from "@domain/moddbVisibility"
import { getConfig, saveConfig } from "@src/config/configManager"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

const LOG_PREFIX = "[back] [ipc] [ipc/handlers/netHandlers.ts]"

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
        logMessage("debug", `${LOG_PREFIX} [QUERY_URL] Failed to write mod catalog cache: ${getErrorMessage(cacheErr)}`)
      })
    }
    return text
  } catch (err) {
    if (isCatalog) {
      const cached = await readCatalogCache(safeUrl)
      if (cached !== null) {
        logMessage("warn", `${LOG_PREFIX} [QUERY_URL] Mod catalog fetch failed, serving last good cached response.`)
        logMessage("debug", `${LOG_PREFIX} [QUERY_URL] ${getErrorMessage(err)}`)
        return cached
      }
    }
    throw err
  }
}

/**
 * Whether this process has already tried to count. One attempt per launch, whatever asks and
 * whatever came of it: a listing that is unreachable, or that has no entry for this version yet,
 * is retried on a later launch rather than on a loop inside this one. The config's own
 * `countedVersions` is what stops a version being counted twice across launches (#477).
 */
let listingCountAttempted = false
let listingCountPromise: Promise<ModDbCountResult> | null = null

/**
 * Fetches the launcher's own listing entry for `listingVersion`, which is what registers a
 * download against that entry (see src/domain/moddbVisibility.ts for why it is the only URL that
 * counts).
 *
 * The entry is resolved by name rather than taken from the top of the list: the point of #477 is
 * that the count lands on the version being run, and the newest entry is a different one on every
 * launch of a beta. A version with no entry yet answers `no-entry`, which is the ordinary state
 * for the first launches after a release and not a failure.
 *
 * The two requests get a `try` each rather than sharing one, so which of them failed is never in
 * doubt. Only the second can be a counted outcome: the first runs before any file id exists, and a
 * redirect out of it means the API moved, not that anything was registered.
 */
export async function fetchModDbListingArchive(listingVersion: string): Promise<ModDbCountReason> {
  let fileId: number | undefined

  try {
    const detailUrl = assertAllowedApiUrl(MODDB_LISTING_DETAIL_URL)
    const detail = parseModDetailResponse(await requestBoundedText(detailUrl, { maxBytes: getApiUrlMaxBytes(detailUrl) }))
    if (!detail.ok) return "unreachable"
    fileId = releaseFileIdForVersion(detail.payload, listingVersion)
  } catch (err) {
    logMessage("debug", `${LOG_PREFIX} [COUNT_MODDB_DOWNLOAD] ${getErrorMessage(err)}`)
    return "unreachable"
  }

  if (fileId === undefined) return "no-entry"

  try {
    await requestBoundedBuffer(assertAllowedDownloadUrl(moddbListingDownloadUrl(fileId)), { maxBytes: MAX_MODDB_LISTING_RESPONSE_BYTES })
    return "counted"
  } catch (err) {
    const message = getErrorMessage(err)

    // ModDB answers the counting endpoint with a 302 to its CDN, and the bounded network layer
    // refuses to follow redirects, so this rejection is what a counted request looks like from
    // here rather than a failure. Reading the message is the only signal available; if Electron
    // ever rewords it the request still behaves exactly the same and only this line falls back
    // to the branch below.
    if (message.toLowerCase().includes("redirect")) {
      logMessage("debug", `${LOG_PREFIX} [COUNT_MODDB_DOWNLOAD] The listing download endpoint answered with its redirect, which is the counted outcome. Not followed on purpose.`)
      return "counted"
    }

    logMessage("debug", `${LOG_PREFIX} [COUNT_MODDB_DOWNLOAD] ${message}`)
    return "unreachable"
  }
}

/** The player's answer when they just gave one, or null for the silent count a stored `always` owes this launch. */
function readConsent(value: unknown): ModDbVisibilityConsent | null {
  return value === MODDB_VISIBILITY_ONCE || value === MODDB_VISIBILITY_ALWAYS ? value : null
}

/**
 * Records the answer, and counts this version on the listing when that answer says to.
 *
 * The order is deliberate. The answer on disk is the ledger that says this version has been asked
 * about, so nothing may be requested until that ledger entry is durable: a crash between the
 * request and the write would leave the counter incremented and the question unanswered, and the
 * next launch would ask and count again.
 *
 * The counted version is written after the request rather than before, which is the one place this
 * differs from #219. An entry that does not exist yet is the normal state for the first launches
 * of a beta, and recording the version as counted before knowing that would burn the count for
 * that version rather than retry it on the launch after the entry is uploaded. The loss that
 * direction, a crash between the endpoint answering and the write, costs the listing one double
 * count for one player rather than every early launcher losing its count.
 *
 * Owned by the main process for the same reason it was in #219. The renderer's config saves are
 * coalesced and fire-and-forget, which is right for a window size and wrong for a promise about
 * how many times a counter may move. The state this answers with is what the renderer mirrors, so
 * the two copies of the config cannot disagree about what was counted.
 */
async function countModDbDownloadOnce(consent: unknown): Promise<ModDbCountResult> {
  const runningVersion = app.getVersion()
  const config = await getConfig()
  const chosen = readConsent(consent)
  const answered = chosen === null ? config.moddbVisibility : answerModDbVisibility(config.moddbVisibility, chosen, runningVersion)
  const owed = moddbLaunchAction(answered, runningVersion) === "count" && !listingCountAttempted

  // An answer is still an answer when nothing is owed (a second click, a version already counted),
  // so it is recorded either way and only the request is refused.
  if (chosen !== null || owed) {
    if (!(await saveConfig({ ...config, moddbVisibility: answered }))) return { reason: "not-saved", visibility: config.moddbVisibility }
  }

  if (!owed) return { reason: "not-allowed", visibility: answered }

  listingCountAttempted = true
  const reason = await fetchModDbListingArchive(moddbListingVersion(runningVersion))
  if (reason !== "counted") return { reason, visibility: answered }

  const counted = rememberCountedVersion(answered, runningVersion)
  await saveConfig({ ...(await getConfig()), moddbVisibility: counted })
  return { reason, visibility: counted }
}

/**
 * The renderer normally de-duplicates this call, but the main process is the
 * authority and must keep the at-most-once promise on its own. Two trusted IPC
 * invocations can still arrive in the same turn before the network request has
 * set `listingCountAttempted`; sharing the in-flight result closes that window.
 */
export async function countModDbDownload(consent: unknown): Promise<ModDbCountResult> {
  listingCountPromise ??= countModDbDownloadOnce(consent)

  try {
    return await listingCountPromise
  } finally {
    listingCountPromise = null
  }
}

ipcMain.handle(IPC_CHANNELS.NET_MANAGER.COUNT_MODDB_DOWNLOAD, async (event, consent: unknown): Promise<ModDbCountResult> => {
  assertTrustedIpcSender(event)
  const result = await countModDbDownload(consent)

  // Fixed text and the outcome's own token only, never a URL or a response body: the provenance
  // rule tests/log-provenance.test.ts holds every network log in this file to.
  logMessage("info", `${LOG_PREFIX} [COUNT_MODDB_DOWNLOAD] ModDB listing count for this version: ${result.reason}.`)

  return result
})

ipcMain.handle(IPC_CHANNELS.NET_MANAGER.QUERY_URL, async (event, url: unknown): Promise<string> => {
  assertTrustedIpcSender(event)

  try {
    return await queryUrl(url)
  } catch (err) {
    logMessage("error", `${LOG_PREFIX} [QUERY_URL] Network request failed.`)
    logMessage("debug", `${LOG_PREFIX} [QUERY_URL] ${getErrorMessage(err)}`)
    throw err
  }
})

const RELEASE_NOTES_URL = "https://api.github.com/repos/StratumServer/RiftLauncher/releases?per_page=10"

// 5 seconds, not the transport's usual 15: this only ever feeds a dialog the player is not
// blocked on (see useWhatsNew.ts), so it has no reason to hold a launch's network activity open
// as long as an ordinary API call does.
const RELEASE_NOTES_TIMEOUT_MS = 5_000

const GITHUB_ACCEPT_HEADER = "application/vnd.github+json"

// GitHub's API refuses an empty User-Agent outright; naming the launcher is also what a
// maintainer would want to see in GitHub's own request logs if this endpoint ever misbehaves.
const GITHUB_USER_AGENT = "RiftLauncher"

/** Chromium's redirect refusals, the shape a `redirect: "error"` request fails with: ERR_UNEXPECTED_REDIRECT, ERR_UNSAFE_REDIRECT, ERR_TOO_MANY_REDIRECTS. */
const REDIRECT_ERROR = /\bERR_[A-Z_]*REDIRECT/

/**
 * Per-field ceilings, applied here so no single release can push the renderer a field larger than
 * the whole list is supposed to be. The 256 KiB response cap bounds all ten releases together;
 * without these a response could spend all of it on one body. 128 for a tag (a semver string with
 * room to spare), 256 for a name (one line), 64 KiB for a body (the longest this project has
 * published is under 7 KB, and it is what releaseNotesToBlocks slices to anyway), 64 for an ISO
 * timestamp.
 */
const MAX_RELEASE_TAG_LENGTH = 128
const MAX_RELEASE_NAME_LENGTH = 256
const MAX_RELEASE_BODY_LENGTH = 64 * 1024
const MAX_RELEASE_PUBLISHED_AT_LENGTH = 64

/** A string field of a release, capped, or the given fallback when the API sent something that is not a string. */
function releaseText(value: unknown, maxLength: number, fallback: string): string {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback
}

/** One release entry off the raw API response, kept only when it carries a usable tag. Everything else about it defaults rather than rejects the whole release, and every field is capped before it crosses IPC. */
function validateReleaseEntry(value: unknown): WhatsNewReleaseInfo | undefined {
  if (!isRecord(value)) return undefined
  const tag = value["tag_name"]
  if (typeof tag !== "string" || tag.length === 0 || tag.length > MAX_RELEASE_TAG_LENGTH) return undefined

  return {
    tag,
    name: releaseText(value["name"], MAX_RELEASE_NAME_LENGTH, tag),
    body: releaseText(value["body"], MAX_RELEASE_BODY_LENGTH, ""),
    prerelease: value["prerelease"] === true,
    draft: value["draft"] === true,
    publishedAt: releaseText(value["published_at"], MAX_RELEASE_PUBLISHED_AT_LENGTH, "")
  }
}

/** The response body as a release list, or undefined for anything that is not JSON, or not a JSON array. */
function parseReleaseNotesResponse(rawText: string): WhatsNewReleaseInfo[] | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(rawText)
  } catch {
    return undefined
  }

  if (!Array.isArray(parsed)) return undefined
  return parsed.map(validateReleaseEntry).filter((release): release is WhatsNewReleaseInfo => release !== undefined)
}

/** One HTTP header's value as a single string, Node's `string | string[]` folded down to its first entry the same way the content-length check above already does. */
function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Maps whatever the fetch or the parse threw onto the closed vocabulary FETCH_RELEASE_NOTES is
 * allowed to log: never the error's own message, which could carry a header value or a URL this
 * process does not control the content of.
 */
function releaseNotesFailureReason(error: unknown): FetchReleaseNotesFailureReason {
  if (error instanceof BoundedResponseError) {
    // 403 with the remaining count at zero is the primary rate limit; 429 is the secondary one,
    // which GitHub sends for a burst even while the hourly budget still has room.
    if (error.statusCode === 429) return "rate-limited"
    if (error.statusCode === 403 && headerValue(error.headers, "x-ratelimit-remaining") === "0") return "rate-limited"
    return "bad-response"
  }

  if (error instanceof Error && error.message === "Network response is too large") return "too-large"

  // The transport refuses to follow a redirect (network.ts, `redirect: "error"`), which surfaces
  // as a transport error rather than a status. That is the repository having been renamed or
  // moved, not a machine that is offline: calling it offline would have the launcher retry it on
  // every launch forever, when the answer will never change until this file's URL does.
  if (error instanceof Error && REDIRECT_ERROR.test(error.message)) return "bad-response"

  return "offline"
}

/**
 * Fetches this repository's GitHub releases for the "what's new" dialog and the Info & Help
 * page's own section (#439).
 *
 * The same source the auto-updater already reads from, rather than the update-available event: a
 * player who updated through a package manager or a manual download never sees that event at all,
 * and the notes have to reach them too.
 */
export async function fetchReleaseNotes(): Promise<FetchReleaseNotesResult> {
  const url = assertAllowedApiUrl(RELEASE_NOTES_URL)

  try {
    const text = await requestBoundedText(url, {
      maxBytes: getApiUrlMaxBytes(url),
      timeoutMs: RELEASE_NOTES_TIMEOUT_MS,
      accept: GITHUB_ACCEPT_HEADER,
      headers: { "User-Agent": GITHUB_USER_AGENT }
    })

    const releases = parseReleaseNotesResponse(text)
    if (!releases) return { ok: false, reason: "bad-response" }
    return { ok: true, releases }
  } catch (err) {
    return { ok: false, reason: releaseNotesFailureReason(err) }
  }
}

ipcMain.handle(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES, async (event): Promise<FetchReleaseNotesResult> => {
  assertTrustedIpcSender(event)
  const result = await fetchReleaseNotes()

  // Fixed text and the failure's own reason token only: never the response body, a release name
  // or the URL, the same provenance rule every other network log in this file already follows.
  if (!result.ok) logMessage("info", `${LOG_PREFIX} [FETCH_RELEASE_NOTES] Release notes fetch failed: ${result.reason}.`)

  return result
})
