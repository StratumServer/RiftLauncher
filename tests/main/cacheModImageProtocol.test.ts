import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import { IconMemoryCache } from "@domain/mods/iconMemoryCache"
import { createCacheModImageProtocolHandler } from "@src/main/protocolFiles"

type FetchFile = (url: string) => Promise<Response>

let userDataPath = ""
let iconRoot = ""

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), "riftlauncher-cachemodimg-"))
  iconRoot = join(userDataPath, "Cache", "Images", "Mods")
  mkdirSync(iconRoot, { recursive: true })
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function iconPath(name: string): string {
  return join(iconRoot, name)
}

function request(path: string): Request {
  return new Request(`cachemodimg://launcher${path}`)
}

function createHandler(fetchFile: FetchFile, maxBytes = 1_024): (request: Request) => Promise<Response> {
  return createCacheModImageProtocolHandler({
    cache: new IconMemoryCache(maxBytes),
    getUserDataPath: () => userDataPath,
    fetchFile
  })
}

describe("cachemodimg protocol handler", () => {
  it("returns the PNG bytes and response headers on a cache miss", async () => {
    const filePath = iconPath("aa.png")
    const bytes = Buffer.from([1, 2, 3])
    writeFileSync(filePath, bytes)

    const fetchFile = vi.fn<FetchFile>(async (url) => {
      assert.equal(url, pathToFileURL(filePath).toString())
      return new Response(bytes)
    })

    const response = await createHandler(fetchFile)(request("/aa.png"))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("Content-Type"), "image/png")
    assert.equal(response.headers.get("Content-Length"), String(bytes.length))
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    assert.equal(fetchFile.mock.calls.length, 1)
  })

  it("serves a cache hit without fetching the file again", async () => {
    const filePath = iconPath("aa.png")
    const bytes = Buffer.from("cached icon")
    writeFileSync(filePath, bytes)
    const fetchFile = vi.fn<FetchFile>(async () => new Response(bytes))
    const handler = createHandler(fetchFile)

    const first = await handler(request("/aa.png"))
    const second = await handler(request("/aa.png"))

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), bytes)
    assert.equal(fetchFile.mock.calls.length, 1)
  })

  it("fetches an evicted icon again", async () => {
    const firstPath = iconPath("aa.png")
    const secondPath = iconPath("bb.png")
    writeFileSync(firstPath, "a")
    writeFileSync(secondPath, "b")
    const bytesByUrl = new Map([
      [pathToFileURL(firstPath).toString(), Buffer.from("a")],
      [pathToFileURL(secondPath).toString(), Buffer.from("b")]
    ])
    const fetchFile = vi.fn<FetchFile>(async (url) => {
      const bytes = bytesByUrl.get(url)
      assert.ok(bytes)
      return new Response(bytes)
    })
    const handler = createHandler(fetchFile, 1)

    await handler(request("/aa.png"))
    await handler(request("/bb.png"))
    await handler(request("/aa.png"))

    assert.deepEqual(
      fetchFile.mock.calls.map(([url]) => url),
      [pathToFileURL(firstPath).toString(), pathToFileURL(secondPath).toString(), pathToFileURL(firstPath).toString()]
    )
  })

  it("checks file safety before serving a cached entry", async () => {
    const filePath = iconPath("aa.png")
    const outsidePath = join(userDataPath, "outside.png")
    const bytes = Buffer.from("cached icon")
    writeFileSync(filePath, bytes)
    writeFileSync(outsidePath, "outside")
    const fetchFile = vi.fn<FetchFile>(async () => new Response(bytes))
    const handler = createHandler(fetchFile)

    const first = await handler(request("/aa.png"))
    rmSync(filePath)
    symlinkSync(outsidePath, filePath)
    const second = await handler(request("/aa.png"))

    assert.equal(first.status, 200)
    assert.equal(second.status, 404)
    assert.equal(fetchFile.mock.calls.length, 1)
  })

  it.skipIf(process.platform === "win32")("rejects a direct symlink", async () => {
    const filePath = iconPath("aa.png")
    const outsidePath = join(userDataPath, "outside.png")
    writeFileSync(outsidePath, "outside")
    symlinkSync(outsidePath, filePath)
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("unexpected")))

    const response = await createHandler(fetchFile)(request("/aa.png"))

    assert.equal(response.status, 404)
    assert.equal(fetchFile.mock.calls.length, 0)
  })

  it("rejects invalid paths without fetching", async () => {
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("unexpected")))
    const handler = createHandler(fetchFile)

    for (const path of ["/%2e%2e/outside.png", "/%ZZ.png", "/", "/aa.jpg"]) {
      const response = await handler(request(path))
      assert.equal(response.status, 404, path)
    }

    assert.equal(fetchFile.mock.calls.length, 0)
  })

  it("rejects missing files and directories", async () => {
    mkdirSync(iconPath("folder.png"))
    const fetchFile = vi.fn<FetchFile>(async () => new Response(Buffer.from("unexpected")))
    const handler = createHandler(fetchFile)

    const missing = await handler(request("/missing.png"))
    const directory = await handler(request("/folder.png"))

    assert.equal(missing.status, 404)
    assert.equal(directory.status, 404)
    assert.equal(fetchFile.mock.calls.length, 0)
  })

  it("returns 404 for a failed file fetch and does not cache it", async () => {
    const filePath = iconPath("aa.png")
    writeFileSync(filePath, "a")
    const fetchFile = vi.fn<FetchFile>(async () => new Response(null, { status: 404 }))
    const handler = createHandler(fetchFile)

    const first = await handler(request("/aa.png"))
    const second = await handler(request("/aa.png"))

    assert.equal(first.status, 404)
    assert.equal(second.status, 404)
    assert.equal(fetchFile.mock.calls.length, 2)
  })

  it("returns 404 when the file fetch throws", async () => {
    const filePath = iconPath("aa.png")
    writeFileSync(filePath, "a")
    const fetchFile = vi.fn<FetchFile>(async () => {
      throw new Error("read failed")
    })

    const response = await createHandler(fetchFile)(request("/aa.png"))

    assert.equal(response.status, 404)
    assert.equal(fetchFile.mock.calls.length, 1)
  })
})
