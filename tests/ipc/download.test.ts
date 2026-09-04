import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, it } from "vitest"

import type { ClientRequest, IncomingMessage } from "node:http"

import { assertSafeFileName, runDownload, type DownloadRequestFn } from "@src/ipc/workers/download"

/**
 * The download's own logic, driven without a socket.
 *
 * `runDownload` takes its transport as a parameter, so these push real bytes
 * through the real write stream, the real digest and the real rename, and only
 * the HTTPS conversation is faked. What is being pinned is the part that
 * decides whether the file on disk is trustworthy: the length check, the digest
 * check, and the rule that nothing lands under the caller's name until both
 * pass.
 *
 * `runDownload` never says why it failed, by design, so most of these assert on
 * the disk instead: no file under the destination name, and no leftover `.part`.
 */

const ALLOWED_URL = "https://cdn.vintagestory.at/gamefiles/stable/vs_client_linux-x64_1.22.6.tar.gz"

let workspace: string
let destination: string

function workspacePath(...parts: string[]): string {
  return join(workspace, ...parts)
}

class FakeResponse extends Readable {
  statusCode: number
  headers: Record<string, string | undefined>
  resumed = false

  private readonly pending: Buffer[]

  constructor(statusCode: number, headers: Record<string, string | undefined>, chunks: Buffer[]) {
    super()
    this.statusCode = statusCode
    this.headers = headers
    this.pending = [...chunks]
  }

  override _read(): void {
    const next = this.pending.shift()
    this.push(next ?? null)
  }

  override resume(): this {
    this.resumed = true
    return super.resume()
  }
}

class FakeRequest extends EventEmitter {
  destroyed = false
  ended = false
  timeoutMs: number | undefined
  timeoutCallback: (() => void) | undefined

  setTimeout(ms: number, callback: () => void): this {
    this.timeoutMs = ms
    this.timeoutCallback = callback
    return this
  }

  end(): void {
    this.ended = true
  }

  /** Mirrors `ClientRequest.destroy(error)`, which surfaces the reason as an `error` event. */
  destroy(error?: Error): void {
    this.destroyed = true
    if (error) this.emit("error", error)
  }
}

/**
 * Records every request the download makes, so a test can drive one after the fact.
 *
 * A request either produces a response or fails, never both, which is what the
 * real `https.request` does too: `answer` decides which.
 */
class Transport {
  readonly requests: FakeRequest[] = []
  readonly urls: URL[] = []

  constructor(private readonly answer: (request: FakeRequest) => FakeResponse | undefined) {}

  get fn(): DownloadRequestFn {
    return (url, _options, callback) => {
      const request = new FakeRequest()
      this.requests.push(request)
      this.urls.push(url)
      // The real `https.request` never calls back inside the same tick: the
      // caller still has to wire its `error` handler and call `end()`.
      setImmediate(() => {
        const response = this.answer(request)
        if (response) callback(response as unknown as IncomingMessage)
      })
      return request as unknown as ClientRequest
    }
  }
}

/** A transport that answers with one response and nothing else. */
function respondWith(response: FakeResponse): { fn: DownloadRequestFn; requests: FakeRequest[]; urls: URL[] } {
  const transport = new Transport(() => response)
  return { fn: transport.fn, requests: transport.requests, urls: transport.urls }
}

function body(...parts: string[]): { chunks: Buffer[]; text: string; md5: string; length: number } {
  const text = parts.join("")
  const chunks = parts.map((part) => Buffer.from(part))
  return { chunks, text, md5: createHash("md5").update(text).digest("hex"), length: Buffer.byteLength(text) }
}

/** Every `.part` file left behind under the destination folder. */
function leftoverParts(): string[] {
  return existsSync(destination) ? readdirSync(destination).filter((entry) => entry.endsWith(".part")) : []
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-download-test-"))
  destination = workspacePath("out")
  mkdirSync(destination)
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("assertSafeFileName", () => {
  it("returns the name it was given", () => {
    assert.equal(assertSafeFileName("vs_client_linux-x64_1.22.6.tar.gz"), "vs_client_linux-x64_1.22.6.tar.gz")
  })

  it("keeps the extension the caller asked for, whatever it is", () => {
    // The suffix used to be forced to `.zip` here, which is how a tar.gz and an
    // installer both landed on disk as `<version>.zip`.
    assert.equal(assertSafeFileName("vs_setup_1.22.6.exe"), "vs_setup_1.22.6.exe")
  })

  for (const [label, value] of [
    ["a non-string", 42],
    ["an empty name", ""],
    ["a name over 255 characters", "a".repeat(256)],
    ["the current folder", "."],
    ["the parent folder", ".."],
    ["a POSIX separator", "nested/name.zip"],
    ["a Windows separator", "nested\\name.zip"],
    ["an embedded NUL", "name\0.zip"]
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.throws(() => assertSafeFileName(value), /Invalid download file name/)
    })
  }
})

describe("runDownload", () => {
  it("writes the response under the requested name and reports progress", async () => {
    const payload = body("vintage", "story")
    const progress: number[] = []
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length) }, payload.chunks))

    const result = await runDownload({
      url: ALLOWED_URL,
      outputPath: destination,
      fileName: "game.tar.gz",
      request: transport.fn,
      onProgress: (value) => progress.push(value)
    })

    assert.equal(result, join(destination, "game.tar.gz"))
    assert.equal(readFileSync(result, "utf8"), payload.text)
    assert.deepEqual(leftoverParts(), [])
    assert.equal(progress.at(-1), 100)
    assert.ok(
      progress.every((value) => value >= 0 && value <= 100),
      `progress left 0-100: ${progress.join(",")}`
    )
  })

  it("coalesces repeated percentages and reports completion once", async () => {
    const progress: number[] = []
    const payload = Array.from({ length: 1_000 }, () => Buffer.from("x"))
    const transport = respondWith(new FakeResponse(200, { "content-length": "1000" }, payload))

    await runDownload({
      url: ALLOWED_URL,
      outputPath: destination,
      fileName: "game.tar.gz",
      request: transport.fn,
      onProgress: (value) => progress.push(value)
    })

    assert.equal(progress.at(-1), 100)
    assert.equal(progress.filter((value) => value === 100).length, 1)
    assert.equal(new Set(progress).size, progress.length)
  })

  it("asks for the URL it was given, once", async () => {
    const payload = body("bytes")
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length) }, payload.chunks))

    await runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn })

    assert.equal(transport.requests.length, 1)
    assert.equal(transport.urls[0]?.toString(), ALLOWED_URL)
    assert.equal(transport.requests[0]?.ended, true)
  })

  it("creates the destination folder when it is missing", async () => {
    const payload = body("bytes")
    const nested = workspacePath("out", "nested", "deeper")
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length) }, payload.chunks))

    const result = await runDownload({ url: ALLOWED_URL, outputPath: nested, fileName: "game.tar.gz", request: transport.fn })

    assert.equal(readFileSync(result, "utf8"), payload.text)
  })

  it("accepts a response that declares no length, and reports no progress for it", async () => {
    const payload = body("no length header here")
    const progress: number[] = []
    const transport = respondWith(new FakeResponse(200, {}, payload.chunks))

    const result = await runDownload({
      url: ALLOWED_URL,
      outputPath: destination,
      fileName: "game.tar.gz",
      request: transport.fn,
      onProgress: (value) => progress.push(value)
    })

    assert.equal(readFileSync(result, "utf8"), payload.text)
    // Nothing to divide by, so the only report is the completion one.
    assert.deepEqual(progress, [100])
  })

  it("keeps the file when the digest matches the one the manifest promised", async () => {
    const payload = body("verified payload")
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length) }, payload.chunks))

    const result = await runDownload({
      url: ALLOWED_URL,
      outputPath: destination,
      fileName: "game.tar.gz",
      expectedMd5: payload.md5.toUpperCase(),
      request: transport.fn
    })

    assert.equal(readFileSync(result, "utf8"), payload.text)
  })

  it("refuses a payload whose digest is not the one the manifest promised", async () => {
    const payload = body("swapped payload")
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length) }, payload.chunks))

    await assert.rejects(
      runDownload({
        url: ALLOWED_URL,
        outputPath: destination,
        fileName: "game.tar.gz",
        expectedMd5: createHash("md5").update("what the manifest listed").digest("hex"),
        request: transport.fn
      }),
      /Download failed/
    )

    assert.equal(existsSync(join(destination, "game.tar.gz")), false)
  })

  it("refuses a payload shorter than the length the response declared", async () => {
    const payload = body("truncated")
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length + 100) }, payload.chunks))

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)

    assert.equal(existsSync(join(destination, "game.tar.gz")), false)
  })

  it("refuses a response that is not a 2xx, and drains it", async () => {
    const response = new FakeResponse(404, { "content-length": "9" }, [Buffer.from("not found")])
    const transport = respondWith(response)

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)

    assert.equal(response.resumed, true)
    assert.equal(existsSync(join(destination, "game.tar.gz")), false)
  })

  it("refuses a response with no status code at all", async () => {
    const response = new FakeResponse(200, {}, [])
    // `IncomingMessage.statusCode` is optional; the handler reads a missing one as 0.
    ;(response as { statusCode?: number }).statusCode = undefined
    const transport = respondWith(response)

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)
  })

  it("refuses a response declaring more bytes than the download cap allows", async () => {
    const transport = respondWith(new FakeResponse(200, { "content-length": String(3 * 1024 * 1024 * 1024) }, []))

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)
  })

  it("refuses a response declaring a negative length", async () => {
    const transport = respondWith(new FakeResponse(200, { "content-length": "-1" }, []))

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)
  })

  it("refuses a URL outside the download allow-list, without asking for it", async () => {
    const transport = respondWith(new FakeResponse(200, {}, []))

    await assert.rejects(runDownload({ url: "https://example.invalid/vs.tar.gz", outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)

    assert.deepEqual(transport.requests, [])
  })

  it("refuses a URL that is not a URL at all", async () => {
    const transport = respondWith(new FakeResponse(200, {}, []))

    await assert.rejects(runDownload({ url: 42, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)

    assert.deepEqual(transport.requests, [])
  })

  it("throws for an unsafe file name instead of reporting a failed download", () => {
    const transport = respondWith(new FakeResponse(200, {}, []))

    // Synchronous on purpose: a name that could escape the folder is a caller
    // bug, and the worker used to fault its thread on it rather than post an
    // error message the renderer would show as a download failure.
    assert.throws(() => runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "../escape", request: transport.fn }), /Invalid download file name/)
  })

  it("refuses to replace a symbolic link standing where the file would land", async () => {
    const target = workspacePath("elsewhere.txt")
    writeFileSync(target, "someone else's file")
    symlinkSync(target, join(destination, "game.tar.gz"))
    const transport = respondWith(new FakeResponse(200, {}, []))

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)

    assert.deepEqual(transport.requests, [])
    assert.equal(readFileSync(target, "utf8"), "someone else's file")
  })

  it("refuses to replace a folder standing where the file would land", async () => {
    mkdirSync(join(destination, "game.tar.gz"))
    const payload = body("bytes")
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length) }, payload.chunks))

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)

    assert.equal(readdirSync(join(destination, "game.tar.gz")).length, 0)
  })

  it("replaces a plain file already sitting under the requested name", async () => {
    writeFileSync(join(destination, "game.tar.gz"), "the previous download")
    const payload = body("the new download")
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length) }, payload.chunks))

    const result = await runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn })

    assert.equal(readFileSync(result, "utf8"), payload.text)
  })

  it("refuses a destination folder that is a symbolic link", async () => {
    const realFolder = workspacePath("real")
    mkdirSync(realFolder)
    const linkedFolder = workspacePath("linked")
    symlinkSync(realFolder, linkedFolder)
    const payload = body("bytes")
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length) }, payload.chunks))

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: linkedFolder, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)

    assert.deepEqual(readdirSync(realFolder), [])
  })

  it("clears a stale part file left by an interrupted run", async () => {
    const payload = body("a complete download this time")
    const transport = respondWith(new FakeResponse(200, { "content-length": String(payload.length) }, payload.chunks))
    // The temporary name carries the launcher namespace, pid and timestamp,
    // so a stale one from this very process is the reachable case: write every
    // shape and let the run pick its own.
    const stalePart = join(destination, `game.tar.gz.riftlauncher.${process.pid}.${Date.now()}.part`)
    writeFileSync(stalePart, "half a download")

    const result = await runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn })

    assert.equal(readFileSync(result, "utf8"), payload.text)
    assert.equal(existsSync(stalePart), false)
  })

  it("fails when the transport errors before any byte arrives", async () => {
    const transport = new Transport((request) => {
      request.emit("error", new Error("socket hang up"))
      return undefined
    })

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)

    assert.deepEqual(leftoverParts(), [])
  })

  it("fails when the response is aborted part way through", async () => {
    const response = new FakeResponse(200, { "content-length": "1000" }, [Buffer.from("the first few")])
    const transport = respondWith(response)
    setTimeout(() => response.emit("aborted"), 5)

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)

    assert.equal(existsSync(join(destination, "game.tar.gz")), false)
  })

  it("fails when the response stream errors part way through", async () => {
    const response = new FakeResponse(200, { "content-length": "1000" }, [Buffer.from("the first few")])
    const transport = respondWith(response)
    setTimeout(() => response.emit("error", new Error("connection reset")), 5)

    await assert.rejects(runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn }), /Download failed/)
  })

  it("arms a timeout that fails the download rather than leaving it hanging", async () => {
    // Nothing ever answers: the request is made and then the socket goes quiet.
    const transport = new Transport(() => undefined)

    const pending = runDownload({ url: ALLOWED_URL, outputPath: destination, fileName: "game.tar.gz", request: transport.fn })
    await new Promise((resolve) => setImmediate(resolve))

    const request = transport.requests[0]
    assert.ok(request, "no request was made")
    assert.equal(request.timeoutMs, 30_000)
    request.timeoutCallback?.()

    await assert.rejects(pending, /Download failed/)
    assert.equal(request.destroyed, true)
  })
})
