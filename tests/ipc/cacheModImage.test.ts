import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronUserDataPath } from "./helpers/electronMock"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

const requestBoundedBuffer = vi.hoisted(() => vi.fn())

vi.mock("@src/ipc/network", () => ({ requestBoundedBuffer }))

type CacheModImageHandler = (event: IpcMainInvokeEvent, url: unknown) => Promise<string | undefined>

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const LOGO_URL = "https://moddbcdn.vintagestory.at/logo.png"

let temporaryRoot: string

function handler(): CacheModImageHandler {
  return getIpcHandler<CacheModImageHandler>(IPC_CHANNELS.MODS_MANAGER.CACHE_MOD_IMAGE)
}

function modImagesFolder(): string {
  return join(temporaryRoot, "Cache", "Images", "Mods")
}

/** The name the store writes for a URL and format: sha256 of the URL, not of the bytes. */
function nameFor(url: string, extension: string): string {
  return `${createHash("sha256").update(url).digest("hex")}${extension}`
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "cache-mod-image-"))
  mkdirSync(temporaryRoot, { recursive: true })
  setElectronUserDataPath(temporaryRoot)
  requestBoundedBuffer.mockReset()

  vi.resetModules()
  await import("@src/ipc/handlers/modsHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("CACHE_MOD_IMAGE", () => {
  it("stores a bounded ModDB PNG under the URL it came from", async () => {
    const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("logo")])
    requestBoundedBuffer.mockResolvedValue(bytes)

    const result = await handler()(await createTrustedEvent(), LOGO_URL)

    assert.equal(result, nameFor(LOGO_URL, ".png"))
    assert.match(result ?? "", /^[0-9a-f]{64}\.png$/)
    assert.deepEqual(readFileSync(join(modImagesFolder(), result ?? "")), bytes)
    assert.deepEqual(requestBoundedBuffer.mock.calls[0]?.[0], new URL(LOGO_URL))
    assert.deepEqual(requestBoundedBuffer.mock.calls[0]?.[1], { maxBytes: 512 * 1024, accept: "image/png,image/jpeg" })
  })

  it("stores a JPEG logo under a .jpg name", async () => {
    const bytes = Buffer.concat([JPEG_SIGNATURE, Buffer.from("photo")])
    requestBoundedBuffer.mockResolvedValue(bytes)

    const result = await handler()(await createTrustedEvent(), "https://moddbcdn.vintagestory.at/0_logo.jpg")

    assert.equal(result, nameFor("https://moddbcdn.vintagestory.at/0_logo.jpg", ".jpg"))
    assert.deepEqual(readFileSync(join(modImagesFolder(), result ?? "")), bytes)
  })

  it("serves a second request for the same logo without opening a socket", async () => {
    requestBoundedBuffer.mockResolvedValue(Buffer.concat([PNG_SIGNATURE, Buffer.from("logo")]))

    const first = await handler()(await createTrustedEvent(), LOGO_URL)
    const second = await handler()(await createTrustedEvent(), LOGO_URL)

    assert.equal(second, first)
    assert.equal(requestBoundedBuffer.mock.calls.length, 1)
  })

  it("refreshes a logo after its cache entry expires", async () => {
    const original = Buffer.concat([PNG_SIGNATURE, Buffer.from("old logo")])
    const replacement = Buffer.concat([PNG_SIGNATURE, Buffer.from("new logo")])
    requestBoundedBuffer.mockResolvedValueOnce(original)

    const first = await handler()(await createTrustedEvent(), LOGO_URL)
    const path = join(modImagesFolder(), first ?? "")
    const expired = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(path, expired, expired)

    requestBoundedBuffer.mockResolvedValueOnce(replacement)
    const refreshed = await handler()(await createTrustedEvent(), LOGO_URL)

    assert.equal(refreshed, first)
    assert.equal(requestBoundedBuffer.mock.calls.length, 2)
    assert.deepEqual(readFileSync(path), replacement)
  })

  it("keeps showing a logo it already has when the network is gone", async () => {
    requestBoundedBuffer.mockResolvedValueOnce(Buffer.concat([PNG_SIGNATURE, Buffer.from("logo")]))
    const first = await handler()(await createTrustedEvent(), LOGO_URL)

    requestBoundedBuffer.mockRejectedValue(new Error("offline"))
    const offline = await handler()(await createTrustedEvent(), LOGO_URL)

    assert.equal(offline, first)
    assert.equal(existsSync(join(modImagesFolder(), first ?? "")), true)
  })

  it("keeps a cached logo looking live to the cache sweep", async () => {
    requestBoundedBuffer.mockResolvedValue(Buffer.concat([PNG_SIGNATURE, Buffer.from("logo")]))
    const name = await handler()(await createTrustedEvent(), LOGO_URL)
    const path = join(modImagesFolder(), name ?? "")
    const stale = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(path, stale, stale)

    await handler()(await createTrustedEvent(), LOGO_URL)

    const stats = statSync(path)
    assert.ok(stats.atimeMs > stale.getTime())
    assert.equal(stats.mtimeMs, stale.getTime())
  })

  it("treats a zero-byte cached file as a miss and refetches", async () => {
    mkdirSync(modImagesFolder(), { recursive: true })
    writeFileSync(join(modImagesFolder(), nameFor(LOGO_URL, ".png")), Buffer.alloc(0))
    requestBoundedBuffer.mockResolvedValue(Buffer.concat([PNG_SIGNATURE, Buffer.from("logo")]))

    const result = await handler()(await createTrustedEvent(), LOGO_URL)

    assert.equal(result, nameFor(LOGO_URL, ".png"))
    assert.equal(requestBoundedBuffer.mock.calls.length, 1)
    assert.ok(readFileSync(join(modImagesFolder(), result ?? "")).length > 0)
  })

  it("keeps responses that are neither PNG nor JPEG, and non-ModDB hosts, out of the cache", async () => {
    requestBoundedBuffer.mockResolvedValue(Buffer.from("not an image"))

    const notImage = await handler()(await createTrustedEvent(), LOGO_URL)
    const wrongHost = await handler()(await createTrustedEvent(), "https://cdn.vintagestory.at/logo.png")

    assert.equal(notImage, undefined)
    assert.equal(wrongHost, undefined)
    assert.equal(existsSync(modImagesFolder()), false)
    assert.equal(requestBoundedBuffer.mock.calls.length, 1)
  })

  it("rejects an untrusted renderer before reading the network", async () => {
    await assert.rejects(() => handler()(createUntrustedEvent(), LOGO_URL), /Unauthorized IPC sender/)
    assert.equal(requestBoundedBuffer.mock.calls.length, 0)
  })
})
