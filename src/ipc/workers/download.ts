/**
 * Fetching one artifact over HTTPS onto disk, without the worker plumbing.
 *
 * The worker thread is a shim over this module, the same split extraction.ts
 * and innoExtraction.ts already use, so the same code can be driven from a test
 * or a script. Nothing here touches Electron or `worker_threads`.
 *
 * The bytes land in a temporary sibling file and are only renamed onto the
 * caller's name once the length and the digest both check out, so a truncated
 * or swapped payload never appears under the name the rest of the launcher
 * trusts.
 */

import { createWriteStream, lstatSync, renameSync, unlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http"
import { request as httpsRequest } from "node:https"
import fse from "fs-extra"
import { join } from "node:path"

// Relative so the module stays importable from a plain test run, like extraction.ts.
import { assertAllowedDownloadUrl, assertAllowedRedirectUrl } from "../validation"

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000

/**
 * How many redirects one download follows.
 *
 * Three, because that is what the longest real chain needs: GitHub's
 * `releases/latest/download/<name>` answers with a 302 to
 * `releases/download/<tag>/<name>`, which answers with a second 302 to the
 * signed asset CDN. Three leaves one hop of slack and still turns a redirect
 * loop into a refusal rather than a spin.
 */
const MAX_DOWNLOAD_REDIRECTS = 3

function isRedirectStatus(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308
}

/** Namespace used by temporary download siblings and the orphan sweep. */
export const DOWNLOAD_TEMP_FILE_NAMESPACE = "riftlauncher"

/**
 * The download is saved under exactly the name the caller asked for.
 *
 * It used to gain a `.zip` suffix here whatever the format really was, which is
 * how a Linux `.tar.gz` and a Windows `.exe` both ended up on disk as
 * `<version>.zip` and broke extraction and the installer alike.
 */
export function assertSafeFileName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || value === "." || value === ".." || /[\\/\0]/.test(value)) throw new Error("Invalid download file name")
  return value
}

/** The `https.request` shape, so a test can answer without a socket. */
export type DownloadRequestFn = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest

export interface DownloadOptions {
  /** Download URL. Checked against the allow-list in `src/ipc/validation.ts`. */
  url: unknown
  /** Folder the file lands in. Created when missing. */
  outputPath: string
  /** Name to save under, exactly as given. */
  fileName: unknown
  /** MD5 the finished file has to match, when the caller knows one. */
  expectedMd5?: unknown
  /**
   * SHA-256 the finished file has to match, when the caller knows one.
   *
   * Beside the MD5 rather than replacing it: the game catalog publishes MD5 and
   * nothing else, and Optimum's overlay manifest publishes SHA-256 and nothing
   * else. Whichever one is set picks the digest the file is hashed with, so
   * neither source pays for the other's choice, and setting both is a caller
   * bug that resolves in favour of SHA-256.
   */
  expectedSha256?: unknown
  /** Transport, defaulting to Node's `https.request`. */
  request?: DownloadRequestFn
  /** Called with 0 to 100 as the bytes arrive, and once with 100 at the end. */
  onProgress?: (progress: number) => void
}

/**
 * Downloads one URL into one folder.
 *
 * @param options Source, destination, and how to report progress.
 * @returns The path the finished file was renamed onto.
 * @throws Synchronously when the file name could escape the folder. That is a
 * caller bug rather than a failed download, and it stays a synchronous throw
 * because the worker used to make this check at module scope, where it faulted
 * the thread instead of posting a download failure.
 * @throws Asynchronously, as a rejection, for every transport, filesystem,
 * length and digest failure. The reason is deliberately uniform: the caller
 * reports "Download failed" and nothing about a refused download is worth
 * telling the renderer apart.
 */
export function runDownload(options: DownloadOptions): Promise<string> {
  const { url, outputPath, fileName, expectedMd5, expectedSha256, request = httpsRequest, onProgress } = options
  const pathToDownload = join(outputPath, assertSafeFileName(fileName))
  const temporaryPath = `${pathToDownload}.${DOWNLOAD_TEMP_FILE_NAMESPACE}.${process.pid}.${Date.now()}.part`
  const expectedDigest = typeof expectedSha256 === "string" ? expectedSha256 : expectedMd5

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let settled = false
    let activeRequest: ClientRequest | undefined
    let responseStream: IncomingMessage | undefined
    let writer: ReturnType<typeof createWriteStream> | undefined
    const digest = createHash(typeof expectedSha256 === "string" ? "sha256" : "md5")

    function fail(): void {
      if (settled) return
      settled = true
      activeRequest?.destroy()
      responseStream?.destroy()
      writer?.destroy()
      void fse.remove(temporaryPath).catch(() => undefined)
      rejectPromise(new Error("Download failed"))
    }

    try {
      const parsedUrl = assertAllowedDownloadUrl(url)
      if (fse.existsSync(pathToDownload) && lstatSync(pathToDownload).isSymbolicLink()) throw new Error("Refusing to replace a symbolic link")
      if (fse.existsSync(temporaryPath)) unlinkSync(temporaryPath)

      if (parsedUrl.protocol !== "https:") {
        fail()
        return
      }

      /**
       * Makes one request and, when the answer is a redirect, makes the next one.
       *
       * Every hop is checked again before it is followed (see
       * REDIRECT_URL_RULES in src/ipc/validation.ts), so a redirect can only
       * ever move the download between hosts the launcher already trusts, and
       * the hop count bounds a loop. No `Authorization` header is ever set on
       * the first request, so there is none to leak across a hop either.
       *
       * A superseded request keeps its own `error` listener, which checks
       * identity before failing the download: a socket closing behind a
       * redirect that was already followed is not a failed download.
       */
      const send = (target: URL, redirectsLeft: number): void => {
        const outgoing = request(target, { method: "GET", headers: { Accept: "application/octet-stream" } }, (response) => {
          if (settled || outgoing !== activeRequest) {
            response.resume()
            return
          }

          responseStream = response
          const statusCode = response.statusCode ?? 0
          const contentLength = Number(response.headers["content-length"])

          if (isRedirectStatus(statusCode)) {
            response.resume()
            responseStream = undefined
            const location = response.headers["location"]

            if (redirectsLeft <= 0 || typeof location !== "string") {
              fail()
              return
            }

            let nextUrl: URL
            try {
              nextUrl = assertAllowedRedirectUrl(new URL(location, target).toString())
            } catch {
              fail()
              return
            }

            send(nextUrl, redirectsLeft - 1)
            return
          }

          if (statusCode < 200 || statusCode >= 300 || (Number.isFinite(contentLength) && (contentLength < 0 || contentLength > MAX_DOWNLOAD_BYTES))) {
            response.resume()
            fail()
            return
          }

          try {
            fse.ensureDirSync(outputPath)
            if (lstatSync(outputPath).isSymbolicLink()) throw new Error("Download destination is a symbolic link")
            writer = createWriteStream(temporaryPath, { flags: "wx" })
          } catch {
            fail()
            return
          }

          let downloadedLength = 0
          let lastReportedProgress = 0

          const reportProgress = (chunk: Buffer): void => {
            if (settled) return
            downloadedLength += chunk.length
            digest.update(chunk)
            if (downloadedLength > MAX_DOWNLOAD_BYTES) {
              fail()
              return
            }

            if (Number.isFinite(contentLength) && contentLength > 0) {
              // Keep completion on the single explicit report below. A response can
              // reach 100% before the writable stream emits its finish event.
              const progress = Math.min(99, Math.round((downloadedLength / contentLength) * 100))
              if (progress > lastReportedProgress) {
                lastReportedProgress = progress
                onProgress?.(progress)
              }
            }
          }

          response.on("data", reportProgress)
          response.on("aborted", fail)
          response.on("error", fail)
          writer.on("error", fail)
          writer.on("finish", () => {
            if (settled) return
            try {
              if (Number.isFinite(contentLength) && contentLength >= 0 && downloadedLength !== contentLength) throw new Error("Downloaded artifact length mismatch")
              if (typeof expectedDigest === "string" && digest.digest("hex") !== expectedDigest.toLowerCase()) throw new Error("Downloaded artifact digest mismatch")
              if (fse.existsSync(pathToDownload)) {
                const existing = lstatSync(pathToDownload)
                if (existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Refusing to replace an unsafe download target")
                unlinkSync(pathToDownload)
              }
              renameSync(temporaryPath, pathToDownload)
              settled = true
              onProgress?.(100)
              resolvePromise(pathToDownload)
            } catch {
              fail()
            }
          })

          response.pipe(writer)
        })

        activeRequest = outgoing
        outgoing.setTimeout(DOWNLOAD_TIMEOUT_MS, () => outgoing.destroy(new Error("Download timed out")))
        outgoing.on("error", () => {
          if (outgoing === activeRequest) fail()
        })
        outgoing.end()
      }

      send(parsedUrl, MAX_DOWNLOAD_REDIRECTS)
    } catch {
      fail()
    }
  })
}
