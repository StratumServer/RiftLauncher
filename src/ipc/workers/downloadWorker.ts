import { createWriteStream, lstatSync, renameSync, unlinkSync } from "fs"
import type { ClientRequest, IncomingMessage } from "http"
import { request as httpsRequest } from "https"
import fse from "fs-extra"
import { join } from "path"
import { parentPort, workerData } from "worker_threads"

import { assertAllowedDownloadUrl } from "@src/ipc/validation"
import { createHash } from "crypto"

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
const { url, outputPath, fileName, expectedMd5 } = workerData
const pathToDownload = join(outputPath, `${fileName}.zip`)
const temporaryPath = `${pathToDownload}.${process.pid}.${Date.now()}.part`

let settled = false
let activeRequest: ClientRequest | undefined
let responseStream: IncomingMessage | undefined
let writer: ReturnType<typeof createWriteStream> | undefined
const digest = createHash("md5")

function fail(): void {
  if (settled) return
  settled = true
  activeRequest?.destroy()
  responseStream?.destroy()
  writer?.destroy()
  void fse.remove(temporaryPath).catch(() => undefined)
  parentPort?.postMessage({ type: "error", message: "Download failed" })
}

try {
  const parsedUrl = assertAllowedDownloadUrl(url)
  if (fse.existsSync(pathToDownload) && lstatSync(pathToDownload).isSymbolicLink()) throw new Error("Refusing to replace a symbolic link")
  if (fse.existsSync(temporaryPath)) unlinkSync(temporaryPath)

  if (parsedUrl.protocol !== "https:") {
    fail()
  } else {
    activeRequest = httpsRequest(parsedUrl, { method: "GET", headers: { Accept: "application/octet-stream" } }, (response) => {
      responseStream = response
      const statusCode = response.statusCode ?? 0
      const contentLength = Number(response.headers["content-length"])

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
          const progress = Math.min(100, Math.round((downloadedLength / contentLength) * 100))
          if (progress >= lastReportedProgress) {
            lastReportedProgress = progress
            parentPort?.postMessage({ type: "progress", progress })
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
          if (typeof expectedMd5 === "string" && digest.digest("hex") !== expectedMd5.toLowerCase()) throw new Error("Downloaded artifact digest mismatch")
          if (fse.existsSync(pathToDownload)) {
            const existing = lstatSync(pathToDownload)
            if (existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Refusing to replace an unsafe download target")
            unlinkSync(pathToDownload)
          }
          renameSync(temporaryPath, pathToDownload)
          settled = true
          parentPort?.postMessage({ type: "progress", progress: 100 })
          parentPort?.postMessage({ type: "finished", path: pathToDownload })
        } catch {
          fail()
        }
      })

      response.pipe(writer)
    })

    activeRequest.setTimeout(DOWNLOAD_TIMEOUT_MS, () => activeRequest?.destroy(new Error("Download timed out")))
    activeRequest.on("error", fail)
    activeRequest.end()
  }
} catch {
  fail()
}
