import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import { createBackgroundProtocolHandler } from "@src/main/protocolFiles"

/**
 * The `background:` protocol handler, mirroring tests/main/cacheModImageProtocol.test.ts.
 *
 * The URLs here have no host: the scheme is registered non-standard on purpose, so
 * `background:village-lane.jpg` is what the renderer actually asks for and `pathname` is the bare
 * file name. Using `background://launcher/...` would test a URL shape the app never produces.
 */
type FetchFile = (url: string) => Promise<Response>

let userDataPath = ""
let backgroundRoot = ""

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), "riftlauncher-background-"))
  backgroundRoot = join(userDataPath, "Cache", "Backgrounds")
  mkdirSync(backgroundRoot, { recursive: true })
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function backgroundPath(name: string): string {
  return join(backgroundRoot, name)
}

function request(path: string): Request {
  return new Request(`background:${path}`)
}

function createHandler(fetchFile: FetchFile): (request: Request) => Promise<Response> {
  return createBackgroundProtocolHandler({ getUserDataPath: () => userDataPath, fetchFile })
}

describe("background protocol handler", () => {
  it("returns the JPEG bytes and response headers", async () => {
    const filePath = backgroundPath("village-lane.jpg")
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    writeFileSync(filePath, bytes)

    const fetchFile = vi.fn<FetchFile>(async (url) => {
      assert.equal(url, pathToFileURL(filePath).toString())
      return new Response(bytes)
    })

    const response = await createHandler(fetchFile)(request("village-lane.jpg"))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("Content-Type"), "image/jpeg")
    assert.equal(response.headers.get("Content-Length"), String(bytes.length))
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  })

  it("ignores the cache-busting query the renderer appends", async () => {
    const filePath = backgroundPath("custom.jpg")
    writeFileSync(filePath, "jpeg")
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("jpeg")))

    const response = await createHandler(fetchFile)(request("custom.jpg?r=7"))

    assert.equal(response.status, 200)
    assert.equal(fetchFile.mock.calls[0]![0], pathToFileURL(filePath).toString())
  })

  it("reads the file again on every request, so a replaced custom picture is never stale", async () => {
    const filePath = backgroundPath("custom.jpg")
    writeFileSync(filePath, "first")
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("first")))
    const handler = createHandler(fetchFile)

    await handler(request("custom.jpg"))
    await handler(request("custom.jpg"))

    assert.equal(fetchFile.mock.calls.length, 2)
  })

  it("checks file safety before reading", async () => {
    const filePath = backgroundPath("village-lane.jpg")
    const outsidePath = join(userDataPath, "outside.jpg")
    writeFileSync(filePath, "jpeg")
    writeFileSync(outsidePath, "outside")
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("jpeg")))
    const handler = createHandler(fetchFile)

    const first = await handler(request("village-lane.jpg"))
    rmSync(filePath)
    symlinkSync(outsidePath, filePath)
    const second = await handler(request("village-lane.jpg"))

    assert.equal(first.status, 200)
    assert.equal(second.status, 404)
    assert.equal(fetchFile.mock.calls.length, 1)
  })

  it.skipIf(process.platform === "win32")("rejects a direct symlink", async () => {
    const outsidePath = join(userDataPath, "outside.jpg")
    writeFileSync(outsidePath, "outside")
    symlinkSync(outsidePath, backgroundPath("village-lane.jpg"))
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("unexpected")))

    const response = await createHandler(fetchFile)(request("village-lane.jpg"))

    assert.equal(response.status, 404)
    assert.equal(fetchFile.mock.calls.length, 0)
  })

  it("rejects paths that leave the cache folder, without reading anything", async () => {
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("unexpected")))
    const handler = createHandler(fetchFile)

    for (const path of ["%2e%2e/outside.jpg", "nested/%2e%2e/%2e%2e/outside.jpg", "%ZZ.jpg", "/"]) {
      const response = await handler(request(path))
      assert.equal(response.status, 404, path)
    }

    assert.equal(fetchFile.mock.calls.length, 0)
  })

  it("rejects a real non-JPEG file on disk without serving it", async () => {
    // The gate is on the name, and the file behind that name exists and is perfectly readable.
    // Only the extension check stands between it and the renderer, so this is the row that fails
    // the moment that check is dropped or moved after the read.
    writeFileSync(backgroundPath("payload.png"), "not a background")
    writeFileSync(backgroundPath("config.json"), "{}")
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("unexpected")))
    const handler = createHandler(fetchFile)

    const png = await handler(request("payload.png"))
    const json = await handler(request("config.json"))

    assert.equal(png.status, 404)
    assert.equal(json.status, 404)
    assert.equal(fetchFile.mock.calls.length, 0)
  })

  it("rejects missing files and directories", async () => {
    mkdirSync(backgroundPath("folder.jpg"))
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("unexpected")))
    const handler = createHandler(fetchFile)

    assert.equal((await handler(request("missing.jpg"))).status, 404)
    assert.equal((await handler(request("folder.jpg"))).status, 404)
    assert.equal(fetchFile.mock.calls.length, 0)
  })

  it("returns 404 for a failed read and for one that throws", async () => {
    writeFileSync(backgroundPath("village-lane.jpg"), "jpeg")

    const refused = await createHandler(async () => new Response(null, { status: 404 }))(request("village-lane.jpg"))
    const threw = await createHandler(async () => {
      throw new Error("read failed")
    })(request("village-lane.jpg"))

    assert.equal(refused.status, 404)
    assert.equal(threw.status, 404)
  })
})
