/**
 * The session's copy of Optimum's overlay manifest.
 *
 * One fixed address, `releases/latest/download/optimum-manifest.json`, which is
 * GitHub's own convenience URL for "the newest release's asset by this name".
 * Reading it that way removes an `api.github.com` listing call along with its
 * release-entry validator and its `browser_download_url` field, so there is no
 * assets array to walk and no string from GitHub used as an address.
 *
 * The price is a 302, and the download worker is what follows one, so the
 * manifest comes down through `runDownload` rather than `requestBoundedText`:
 * onto disk in the launcher's own cache, under a 256 KiB ceiling, and parsed
 * back off the file. That also means the manifest is on disk to look at when
 * something goes wrong.
 *
 * Cached for the session the way `officialManifestCache` is
 * (src/ipc/artifactVerification.ts), and cleared on failure so the next ask
 * retries rather than returning a stuck rejection.
 */

import { app } from "electron"
import fse from "fs-extra"
import { join } from "node:path"

import { parseOptimumManifest, type OptimumManifest } from "@domain/optimum/manifest"
import { hostRid, overlayCacheFolder, overlayDownloadUrl, OPTIMUM_MANIFEST_FILE_NAME, OPTIMUM_MANIFEST_URL } from "@domain/optimum/plan"
import { runDownload } from "@src/ipc/workers/download"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

const LOG_PREFIX = "[back] [ipc] [ipc/optimumManifest.ts]"

/**
 * The manifest is a short document: a version, a platform, one archive, four
 * targets and a few hundred file entries. 256 KiB is orders of magnitude of
 * headroom and still refuses anything that could pass for a payload.
 */
const MAX_OPTIMUM_MANIFEST_BYTES = 256 * 1024

/** Where every Optimum download lands: the manifest, the archive, and the folders staged out of it. */
export function optimumCacheDirectory(): string {
  return join(app.getPath("userData"), "Cache", "Optimum")
}

/** The folder one overlay is staged into, under the cache root. */
export function optimumOverlayDirectory(manifest: OptimumManifest): string {
  return join(optimumCacheDirectory(), overlayCacheFolder(manifest))
}

/** Thrown when a manifest came down and could not be read, or was not for this machine. See {@link getOptimumManifest}. */
class UnusableManifestError extends Error {
  readonly reason: OptimumManifestFailureReason

  constructor(reason: OptimumManifestFailureReason) {
    super(`Unusable Optimum manifest: ${reason}`)
    this.name = "UnusableManifestError"
    this.reason = reason
  }
}

let manifestCache: Promise<OptimumManifest> | undefined

async function fetchOptimumManifest(): Promise<OptimumManifest> {
  const directory = optimumCacheDirectory()
  await fse.ensureDir(directory)

  const manifestPath = await runDownload({
    url: OPTIMUM_MANIFEST_URL,
    outputPath: directory,
    fileName: OPTIMUM_MANIFEST_FILE_NAME,
    maxBytes: MAX_OPTIMUM_MANIFEST_BYTES
  })

  const manifest = parseOptimumManifest(await fse.readFile(manifestPath, "utf8"))
  if (!manifest) throw new UnusableManifestError("unreadable")

  // One manifest is published per release under one name, and it describes one
  // platform's overlay. A manifest for another platform is not a manifest this
  // machine can act on, whatever else it says.
  if (manifest.rid !== hostRid(process.platform, process.arch)) throw new UnusableManifestError("unsupported-system")

  return manifest
}

/**
 * The session's manifest, fetching it the first time it is asked for.
 *
 * Never rejects: a refusal comes back as a reason token the renderer can turn
 * into one calm line.
 */
export async function getOptimumManifest(): Promise<OptimumManifestResult> {
  manifestCache ??= fetchOptimumManifest()

  try {
    const manifest = await manifestCache
    return {
      ok: true,
      manifest: {
        optimumVersion: manifest.optimumVersion,
        supportedGameVersions: manifest.supportedGameVersions,
        downloadUrl: overlayDownloadUrl(manifest),
        downloadFolder: optimumCacheDirectory(),
        archiveFileName: manifest.archive.filename
      }
    }
  } catch (err) {
    manifestCache = undefined
    const reason = err instanceof UnusableManifestError ? err.reason : "unreachable"
    logMessage("info", `${LOG_PREFIX} [GET_MANIFEST] No usable Optimum manifest this session: ${reason}.`)
    logMessage("debug", `${LOG_PREFIX} [GET_MANIFEST] ${getErrorMessage(err)}`)
    return { ok: false, reason }
  }
}

/** The parsed manifest itself, for the handlers that need the file list and the archive hash. Undefined when none was read. */
export async function getCachedOptimumManifest(): Promise<OptimumManifest | undefined> {
  if (!manifestCache) return undefined
  try {
    return await manifestCache
  } catch {
    return undefined
  }
}

/**
 * The SHA-256 a download of Optimum's overlay has to match.
 *
 * Deliberately not part of `getTrustedDownloadHash`, whose contract is "the
 * official Anego manifest": widening that function would blur two trust
 * anchors into one. This one answers off the session manifest and nothing else.
 *
 * @throws When the URL is one of Optimum's release assets and the session
 * manifest does not vouch for it. Failing closed is the point: an overlay whose
 * hash nobody published is an overlay that must not reach the disk, and the
 * only thing downstream of that download is a child process.
 */
export async function getTrustedOverlayHash(url: URL): Promise<string | undefined> {
  if (url.hostname !== "github.com" || !url.pathname.startsWith("/StratumServer/Optimum/")) return undefined

  const manifest = await getCachedOptimumManifest()
  if (!manifest || url.toString() !== overlayDownloadUrl(manifest)) throw new TypeError("Unverified Optimum download")

  return manifest.archive.sha256
}
