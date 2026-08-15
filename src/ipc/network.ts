import { net } from "electron"
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
