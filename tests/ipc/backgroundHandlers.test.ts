import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { registerUserSelectedPaths } from "@src/ipc/pathPolicy"
import { requestBoundedBuffer } from "@src/ipc/network"
import { MAX_BACKGROUND_IMAGE_BYTES } from "@src/ipc/validation"

/**
 * src/ipc/handlers/backgroundHandlers.ts, the two channels the background picker calls.
 *
 * The transport is the one thing mocked: `requestBoundedBuffer` is the narrow port these handlers
 * use, and its own ceiling, timeout and redirect behaviour are covered by tests/ipc/network.test.ts.
 * Everything else stays real, pathPolicy.ts included, so "refuses a file the player never picked"
 * means here what it means in production.
 */
vi.mock("@src/ipc/network", async (importOriginal) => {
  const original = await importOriginal<typeof import("@src/ipc/network")>()
  return { ...original, requestBoundedBuffer: vi.fn() }
})

import "@src/ipc/handlers/backgroundHandlers"

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])

type EnsureHandler = (event: IpcMainInvokeEvent, id: unknown, file: unknown) => Promise<boolean>
type CopyHandler = (event: IpcMainInvokeEvent, path: unknown) => Promise<boolean>

let temporaryRoot: string
let userDataFolder: string
let picksFolder: string

beforeAll(() => {
  // One userData folder for the file: configManager caches the config it reads, and pathPolicy
  // asks it for the managed folders, so moving userData between tests would leave that cache
  // pointing at a folder that no longer exists.
  temporaryRoot = mkdtempSync(join(tmpdir(), "background-handlers-"))
  userDataFolder = join(temporaryRoot, "userData")
  picksFolder = join(temporaryRoot, "picks")
  mkdirSync(userDataFolder, { recursive: true })
  mkdirSync(picksFolder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))
})

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  rmSync(cacheFolder(), { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function cacheFolder(): string {
  return join(userDataFolder, "Cache", "Backgrounds")
}

function cachedPath(name: string): string {
  return join(cacheFolder(), name)
}

function ensureHandler(): EnsureHandler {
  return getIpcHandler<EnsureHandler>(IPC_CHANNELS.BACKGROUNDS_MANAGER.ENSURE_BACKGROUND)
}

function copyHandler(): CopyHandler {
  return getIpcHandler<CopyHandler>(IPC_CHANNELS.BACKGROUNDS_MANAGER.COPY_CUSTOM_BACKGROUND)
}

/** Writes a file where a real open dialog would have put it, and approves it the way that dialog does. */
function pickedFile(name: string, contents: Buffer | string): string {
  const path = join(picksFolder, name)
  writeFileSync(path, contents)
  registerUserSelectedPaths([path])
  return path
}

describe("ENSURE_BACKGROUND", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => ensureHandler()(createUntrustedEvent(), "village-lane", "village-lane.jpg"), /Unauthorized IPC sender/)
  })

  it("downloads the scene and caches it under its own id", async () => {
    vi.mocked(requestBoundedBuffer).mockResolvedValueOnce(JPEG)
    const event = await createTrustedEvent()

    assert.equal(await ensureHandler()(event, "village-lane", "village-lane.jpg"), true)

    const [url, options] = vi.mocked(requestBoundedBuffer).mock.calls[0]!
    assert.equal(url.toString(), "https://raw.githubusercontent.com/StratumServer/RiftLauncher/backgrounds/village-lane.jpg")
    assert.equal(options?.maxBytes, MAX_BACKGROUND_IMAGE_BYTES)
    assert.deepEqual(readFileSync(cachedPath("village-lane.jpg")), JPEG)
  })

  it("does not download a scene that is already cached", async () => {
    mkdirSync(cacheFolder(), { recursive: true })
    writeFileSync(cachedPath("village-lane.jpg"), JPEG)
    const event = await createTrustedEvent()

    assert.equal(await ensureHandler()(event, "village-lane", "village-lane.jpg"), true)
    assert.equal(vi.mocked(requestBoundedBuffer).mock.calls.length, 0)
  })

  it("refuses an id or a file name that could reach outside the cache, without a request", async () => {
    const event = await createTrustedEvent()

    for (const [id, file] of [
      ["../escape", "village-lane.jpg"],
      ["village-lane", "../../etc/passwd"],
      ["village-lane", "nested/village-lane.jpg"],
      ["village-lane", "village-lane.png"],
      ["default", "default.jpg"],
      ["custom", "custom.jpg"],
      [7, "village-lane.jpg"]
    ] as const) {
      assert.equal(await ensureHandler()(event, id, file), false, `${String(id)} ${file}`)
    }

    assert.equal(vi.mocked(requestBoundedBuffer).mock.calls.length, 0)
  })

  it("caches nothing when the download answers with something that is not a JPEG", async () => {
    vi.mocked(requestBoundedBuffer).mockResolvedValueOnce(PNG)
    const event = await createTrustedEvent()

    assert.equal(await ensureHandler()(event, "village-lane", "village-lane.jpg"), false)
    assert.equal(existsSync(cachedPath("village-lane.jpg")), false)
  })

  it("reports a refused or oversized download as a failure rather than throwing", async () => {
    vi.mocked(requestBoundedBuffer).mockRejectedValueOnce(new Error("Network response is too large"))
    const event = await createTrustedEvent()

    assert.equal(await ensureHandler()(event, "village-lane", "village-lane.jpg"), false)
    assert.equal(existsSync(cachedPath("village-lane.jpg")), false)
  })
})

describe("COPY_CUSTOM_BACKGROUND", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => copyHandler()(createUntrustedEvent(), pickedFile("a.jpg", JPEG)), /Unauthorized IPC sender/)
  })

  it("copies the picked JPEG into the cache under the reserved name", async () => {
    const event = await createTrustedEvent()

    assert.equal(await copyHandler()(event, pickedFile("holiday.jpg", JPEG)), true)
    assert.deepEqual(readFileSync(cachedPath("custom.jpg")), JPEG)
  })

  it("replaces the previous copy on a re-pick", async () => {
    const event = await createTrustedEvent()
    const second = Buffer.concat([JPEG, Buffer.from("second")])

    await copyHandler()(event, pickedFile("first.jpg", JPEG))
    assert.equal(await copyHandler()(event, pickedFile("second.jpg", second)), true)

    assert.deepEqual(readFileSync(cachedPath("custom.jpg")), second)
  })

  it("refuses a path the player never picked", async () => {
    const event = await createTrustedEvent()
    const unpicked = join(picksFolder, "unpicked.jpg")
    writeFileSync(unpicked, JPEG)

    assert.equal(await copyHandler()(event, unpicked), false)
    assert.equal(existsSync(cachedPath("custom.jpg")), false)
  })

  it("refuses a file that is not named like a JPEG", async () => {
    const event = await createTrustedEvent()

    assert.equal(await copyHandler()(event, pickedFile("screenshot.png", JPEG)), false)
    assert.equal(existsSync(cachedPath("custom.jpg")), false)
  })

  it("refuses a .jpg that is not a JPEG", async () => {
    const event = await createTrustedEvent()

    assert.equal(await copyHandler()(event, pickedFile("liar.jpg", PNG)), false)
    assert.equal(existsSync(cachedPath("custom.jpg")), false)
  })

  it("refuses a file past the same ceiling the downloads get", async () => {
    const event = await createTrustedEvent()
    const huge = Buffer.concat([JPEG, Buffer.alloc(MAX_BACKGROUND_IMAGE_BYTES)])

    assert.equal(await copyHandler()(event, pickedFile("huge.jpg", huge)), false)
    assert.equal(existsSync(cachedPath("custom.jpg")), false)
  })

  it.skipIf(process.platform === "win32")("refuses a symlink standing in for the picked file", async () => {
    const event = await createTrustedEvent()
    const target = join(picksFolder, "real.jpg")
    const link = join(picksFolder, "link.jpg")
    writeFileSync(target, JPEG)
    rmSync(link, { force: true })
    symlinkSync(target, link)
    registerUserSelectedPaths([link])

    assert.equal(await copyHandler()(event, link), false)
    assert.equal(existsSync(cachedPath("custom.jpg")), false)
  })

  it("refuses to write over a cache entry that is not a plain file", async () => {
    const event = await createTrustedEvent()
    mkdirSync(cachedPath("custom.jpg"), { recursive: true })

    assert.equal(await copyHandler()(event, pickedFile("holiday.jpg", JPEG)), false)
  })
})
