import { net } from "electron"
import { request as httpRequest } from "http"
import { request as httpsRequest } from "https"
import { MAX_RESPONSE_BYTES } from "@src/ipc/validation"

const REQUEST_TIMEOUT_MS = 15_000

type BoundedRequestOptions = {
  method?: "GET" | "POST"
  body?: string
  maxBytes?: number
}

export function requestBoundedText(url: URL, options: BoundedRequestOptions = {}): Promise<string> {
  const method = options.method ?? "GET"
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES

  return new Promise((resolve, reject) => {
    let settled = false
    let responseBytes = 0
    const chunks: Buffer[] = []
    const request = net.request({
      url: url.toString(),
      method,
      redirect: "error",
      credentials: "omit"
    })

    const timeout = setTimeout(() => {
      request.abort()
      finish(new Error("Network request timed out"))
    }, REQUEST_TIMEOUT_MS)

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      if (error) {
        reject(error)
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"))
      }
    }

    request.on("response", (response) => {
      const contentLengthHeader = response.headers["content-length"]
      const contentLengthValue = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader
      const contentLength = Number(contentLengthValue)

      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        request.abort()
        finish(new Error("Network response is too large"))
        return
      }

      if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        request.abort()
        finish(new Error(`Network request failed with status ${response.statusCode ?? "unknown"}`))
        return
      }

      response.on("data", (chunk: Buffer | string) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        responseBytes += chunkBuffer.length

        if (responseBytes > maxBytes) {
          request.abort()
          finish(new Error("Network response is too large"))
          return
        }

        chunks.push(chunkBuffer)
      })
      response.on("end", () => finish())
      response.on("aborted", () => finish(new Error("Network response was aborted")))
      response.on("error", (error) => finish(error))
    })

    request.on("error", (error) => finish(error))
    request.on("login", (_authInfo, callback) => callback())

    request.setHeader("Accept", "application/json, text/plain;q=0.9")
    if (options.body !== undefined) {
      request.setHeader("Content-Type", "application/x-www-form-urlencoded")
      request.end(options.body)
    } else {
      request.end()
    }
  })
}

/**
 * Node-`https`-transport twin of {@link requestBoundedText}, for the one
 * endpoint that refuses Electron's Chromium-flavoured `net.request` (issue
 * #76): the auth service rejects credential posts that carry `net.request`'s
 * `sec-fetch-*` metadata and Chrome User-Agent, neither of which
 * `request.setHeader` can strip. The download worker
 * (`src/ipc/workers/downloadWorker.ts`) already posts through Node's `https`
 * for the same reason of principle, though its shape differs because a
 * multi-gigabyte file download needs a streamed-to-disk write and a
 * socket-inactivity timeout, not the wall-clock timeout this function keeps.
 *
 * Every guarantee `requestBoundedText` carries is preserved here and no
 * caller of `requestBoundedText` is affected, since that function is
 * untouched:
 *  - the response is capped at `maxBytes`, checked against `Content-Length`
 *    up front and against the running streamed total as chunks arrive;
 *  - the whole exchange is bounded by `REQUEST_TIMEOUT_MS`, the same
 *    wall-clock timeout `requestBoundedText` uses (not `request.setTimeout`,
 *    which only measures socket inactivity and would let a slow-trickling
 *    response run forever);
 *  - no redirect is ever followed: `http(s).request`, unlike `fetch`, has no
 *    redirect-following behaviour to opt out of, so a 3xx response is just
 *    another status this function rejects, same as `requestBoundedText`'s
 *    `redirect: "error"`;
 *  - a POST body, and the same `Accept` and `Content-Type` headers.
 *
 * Deliberately absent: a `User-Agent` header. The game's own .NET
 * `HttpClient` sends none and is never refused; adding one back here would
 * reopen this issue.
 *
 * Picks `http` or `https` off `url.protocol` so tests can point this at a
 * plain-`http` server on 127.0.0.1; every real caller passes an `https:` URL.
 *
 * `timeoutMs` exists only so tests can trip the timeout branch without a real
 * 15-second wait; no production caller sets it, so every real call still gets
 * `REQUEST_TIMEOUT_MS`.
 */
export function requestBoundedTextViaNode(url: URL, options: BoundedRequestOptions & { timeoutMs?: number } = {}): Promise<string> {
  const method = options.method ?? "GET"
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const transport = url.protocol === "http:" ? httpRequest : httpsRequest

  const headers: Record<string, string> = { Accept: "application/json, text/plain;q=0.9" }
  if (options.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded"

  return new Promise((resolve, reject) => {
    let settled = false
    let responseBytes = 0
    const chunks: Buffer[] = []

    const request = transport(url, { method, headers }, (response) => {
      const contentLengthHeader = response.headers["content-length"]
      const contentLength = Number(contentLengthHeader)

      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        request.destroy()
        finish(new Error("Network response is too large"))
        return
      }

      if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        request.destroy()
        finish(new Error(`Network request failed with status ${response.statusCode ?? "unknown"}`))
        return
      }

      response.on("data", (chunk: Buffer | string) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        responseBytes += chunkBuffer.length

        if (responseBytes > maxBytes) {
          request.destroy()
          finish(new Error("Network response is too large"))
          return
        }

        chunks.push(chunkBuffer)
      })
      response.on("end", () => finish())
      response.on("aborted", () => finish(new Error("Network response was aborted")))
      response.on("error", (error) => finish(error))
    })

    const timeout = setTimeout(() => {
      request.destroy()
      finish(new Error("Network request timed out"))
    }, timeoutMs)

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      if (error) {
        reject(error)
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"))
      }
    }

    request.on("error", (error) => finish(error))

    if (options.body !== undefined) {
      request.end(options.body)
    } else {
      request.end()
    }
  })
}
