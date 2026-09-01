import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
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

let temporaryRoot: string

function handler(): CacheModImageHandler {
  return getIpcHandler<CacheModImageHandler>(IPC_CHANNELS.MODS_MANAGER.CACHE_MOD_IMAGE)
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
  it("stores a bounded ModDB PNG under its content address", async () => {
    const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("logo")])
    requestBoundedBuffer.mockResolvedValue(bytes)

    const result = await handler()(await createTrustedEvent(), "https://moddbcdn.vintagestory.at/logo.png")

    assert.match(result ?? "", /^[0-9a-f]{64}\.png$/)
    assert.deepEqual(readFileSync(join(temporaryRoot, "Cache", "Images", "Mods", result ?? "")), bytes)
    assert.deepEqual(requestBoundedBuffer.mock.calls[0]?.[0], new URL("https://moddbcdn.vintagestory.at/logo.png"))
    assert.deepEqual(requestBoundedBuffer.mock.calls[0]?.[1], { maxBytes: 512 * 1024, accept: "image/png" })
  })

  it("keeps non-PNG responses and non-ModDB hosts out of the cache", async () => {
    requestBoundedBuffer.mockResolvedValue(Buffer.from("not an image"))

    const nonPng = await handler()(await createTrustedEvent(), "https://moddbcdn.vintagestory.at/logo.png")
    const wrongHost = await handler()(await createTrustedEvent(), "https://cdn.vintagestory.at/logo.png")

    assert.equal(nonPng, undefined)
    assert.equal(wrongHost, undefined)
    assert.equal(existsSync(join(temporaryRoot, "Cache", "Images", "Mods")), false)
    assert.equal(requestBoundedBuffer.mock.calls.length, 1)
  })

  it("rejects an untrusted renderer before reading the network", async () => {
    await assert.rejects(() => handler()(createUntrustedEvent(), "https://moddbcdn.vintagestory.at/logo.png"), /Unauthorized IPC sender/)
    assert.equal(requestBoundedBuffer.mock.calls.length, 0)
  })
})
