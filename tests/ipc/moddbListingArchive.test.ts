import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { MAX_MODDB_LISTING_RESPONSE_BYTES } from "@src/ipc/validation"
import { MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl, MODDB_VISIBILITY_ACCEPTED, MODDB_VISIBILITY_DECLINED, MODDB_VISIBILITY_UNASKED } from "@domain/moddbVisibility"

/**
 * ACCEPT_MODDB_VISIBILITY (src/ipc/handlers/netHandlers.ts), the one request the ModDB visibility
 * prompt makes when a player answers "count me in" (#219), and the config write that has to land
 * before it.
 *
 * The transport is mocked, the way tests/ipc/backgroundHandlers.test.ts mocks it, so the two URLs
 * and their order are observable: the file id has to be resolved from the API before the download
 * endpoint is touched, because that endpoint is the only thing that increments the counter and a
 * stale id would count towards the wrong entry.
 *
 * configManager.ts is not mocked. The point of these tests is that the answer is on disk before
 * anything is requested, which a fake store would assert about itself rather than about the file a
 * later launch actually reads, so the temp userData folder holds a real config.json throughout.
 *
 * `vi.resetModules()` between tests because netHandlers.ts keeps the "already asked once this
 * process" flag in module state, which is the point of it: without a fresh module every test would
 * be measuring the first one's guard. Re-importing it against the same temp folder is also what a
 * relaunch looks like from here: new process state, same config on disk.
 */
const mockState = vi.hoisted(() => ({
  requestBoundedText: vi.fn<(url: URL, options?: unknown) => Promise<string>>(),
  requestBoundedBuffer: vi.fn<(url: URL, options?: unknown) => Promise<Buffer>>(),
  urls: [] as string[],
  logLines: [] as string[]
}))

vi.mock("@src/ipc/network", () => ({
  requestBoundedText: (url: URL, options?: unknown): Promise<string> => {
    mockState.urls.push(url.toString())
    return mockState.requestBoundedText(url, options)
  },
  requestBoundedBuffer: (url: URL, options?: unknown): Promise<Buffer> => {
    mockState.urls.push(url.toString())
    return mockState.requestBoundedBuffer(url, options)
  }
}))

// Mocked beside the transport, and for the same reason: freshHandlers() resets the module registry
// between tests, so a spy installed on the real module would watch an instance the handler no
// longer imports.
vi.mock("@src/utils/logManager", () => ({
  logMessage: (_level: string, message: string): void => {
    mockState.logLines.push(message)
  },
  getErrorMessage: (error: unknown): string => (error instanceof Error ? error.message : String(error))
}))

const FILE_ID = 116745

/** A `/api/mod/11016` body carrying two releases, newest first, the way the API serves them. */
function listingDetail(
  releases: unknown[] = [
    { releaseid: 9, fileid: FILE_ID },
    { releaseid: 8, fileid: 100_000 }
  ]
): string {
  return JSON.stringify({ statuscode: "200", mod: { modid: 11016, name: "RiftLauncher", releases } })
}

let userDataFolder: string

type AcceptHandler = (event: IpcMainInvokeEvent) => Promise<boolean>

/** A netHandlers.ts with its once-per-process flag unset, plus the function the IPC handler delegates to. */
async function freshHandlers(): Promise<typeof import("@src/ipc/handlers/netHandlers")> {
  vi.resetModules()
  return import("@src/ipc/handlers/netHandlers")
}

/** The answer sitting in the temp folder's config.json, or undefined when there is no config there. */
function storedAnswer(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(userDataFolder, "config.json"), "utf-8")).moddbVisibilityAnswer
  } catch {
    return undefined
  }
}

/** Puts a config carrying `answer` on disk, the way a launch that was already answered would find it. */
function storeAnswer(answer: string): void {
  writeFileSync(join(userDataFolder, "config.json"), JSON.stringify({ schemaVersion: 1, moddbVisibilityAnswer: answer }))
}

beforeEach(() => {
  userDataFolder = mkdtempSync(join(tmpdir(), "moddb-listing-archive-"))
  setElectronUserDataPath(userDataFolder)
  mockState.urls.length = 0
  mockState.logLines.length = 0
  mockState.requestBoundedText.mockReset()
  mockState.requestBoundedBuffer.mockReset()
  mockState.requestBoundedText.mockResolvedValue(listingDetail())
  mockState.requestBoundedBuffer.mockResolvedValue(Buffer.from("pointer archive"))
})

afterEach(() => {
  rmSync(userDataFolder, { recursive: true, force: true })
  vi.resetModules()
})

describe("fetchModDbListingArchive", () => {
  it("resolves the current file id from the API before it touches the counting endpoint", async () => {
    const { fetchModDbListingArchive } = await freshHandlers()
    await fetchModDbListingArchive()

    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl(FILE_ID)])
  })

  it("caps the download, which must never be a way to pull a real file", async () => {
    const { fetchModDbListingArchive } = await freshHandlers()
    await fetchModDbListingArchive()

    const [, options] = mockState.requestBoundedBuffer.mock.calls[0] ?? []
    assert.deepEqual(options, { maxBytes: MAX_MODDB_LISTING_RESPONSE_BYTES })
  })

  it("requests once per process, whatever asks it to", async () => {
    const { fetchModDbListingArchive } = await freshHandlers()

    await fetchModDbListingArchive()
    await fetchModDbListingArchive()
    await fetchModDbListingArchive()

    assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 1)
  })

  it("gives up silently when the API cannot be reached, and never guesses a file id", async () => {
    mockState.requestBoundedText.mockRejectedValue(new Error("network down"))
    const { fetchModDbListingArchive } = await freshHandlers()

    await assert.doesNotReject(() => fetchModDbListingArchive())
    assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 0)
  })

  it("gives up silently on an application error the API dressed up as HTTP 200", async () => {
    mockState.requestBoundedText.mockResolvedValue(JSON.stringify({ statuscode: "404" }))
    const { fetchModDbListingArchive } = await freshHandlers()

    await fetchModDbListingArchive()
    assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 0)
  })

  it("gives up silently on a listing with no usable release", async () => {
    mockState.requestBoundedText.mockResolvedValue(listingDetail([]))
    const { fetchModDbListingArchive } = await freshHandlers()

    await fetchModDbListingArchive()
    assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 0)
  })

  it("swallows a failed download, since this is a courtesy and not a task anyone is waiting on", async () => {
    mockState.requestBoundedBuffer.mockRejectedValue(new Error("refused"))
    const { fetchModDbListingArchive } = await freshHandlers()

    await assert.doesNotReject(() => fetchModDbListingArchive())
  })

  it("reads the refused redirect as the counted outcome rather than as a failure", async () => {
    // ModDB answers the counting endpoint with a 302 and the transport refuses to follow it, so
    // this rejection is what success looks like here. Logging it like any other error sends the
    // next person debugging something else down a false trail.
    mockState.requestBoundedBuffer.mockRejectedValue(new Error("Attempted to redirect, but redirect policy was 'error'"))
    const { fetchModDbListingArchive } = await freshHandlers()

    await fetchModDbListingArchive()

    assert.equal(
      mockState.logLines.some((line) => line.includes("counted outcome")),
      true,
      `expected the counted-outcome line, got ${JSON.stringify(mockState.logLines)}`
    )
  })
})

describe("acceptModDbVisibility", () => {
  it("has the answer on disk before it touches the counting endpoint", async () => {
    const { acceptModDbVisibility } = await freshHandlers()

    // The transport records the answer it could read at the moment it was called, which is the
    // only way to see the ordering rather than just the end state.
    let answerWhenRequested: string | undefined
    mockState.requestBoundedBuffer.mockImplementation(async () => {
      answerWhenRequested = storedAnswer()
      return Buffer.from("pointer archive")
    })

    assert.equal(await acceptModDbVisibility(), true)
    assert.equal(answerWhenRequested, MODDB_VISIBILITY_ACCEPTED)
  })

  it("requests nothing when the answer cannot be written, and records nothing either", async () => {
    // A userData folder that does not exist, so every write into it fails the way a full or
    // read-only disk would.
    setElectronUserDataPath(join(userDataFolder, "not-a-folder"))
    const { acceptModDbVisibility } = await freshHandlers()

    assert.equal(await acceptModDbVisibility(), false)
    assert.deepEqual(mockState.urls, [])
    assert.equal(storedAnswer(), undefined)
  })

  it("asks and counts once across a relaunch, since the answer outlives the process", async () => {
    const firstLaunch = await freshHandlers()
    assert.equal(await firstLaunch.acceptModDbVisibility(), true)
    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl(FILE_ID)])

    mockState.urls.length = 0
    const secondLaunch = await freshHandlers()

    // Still accepted on disk, so the prompt never shows again, and the answer being there is
    // exactly what refuses a second count.
    assert.equal(storedAnswer(), MODDB_VISIBILITY_ACCEPTED)
    assert.notEqual(storedAnswer(), MODDB_VISIBILITY_UNASKED)
    assert.equal(await secondLaunch.acceptModDbVisibility(), false)
    assert.deepEqual(mockState.urls, [])
  })
})

describe("ACCEPT_MODDB_VISIBILITY ipcMain.handle wrapper", () => {
  it("refuses an untrusted caller before making any request", async () => {
    await freshHandlers()
    const handler = getIpcHandler<AcceptHandler>(IPC_CHANNELS.NET_MANAGER.ACCEPT_MODDB_VISIBILITY)

    await assert.rejects(() => handler(createUntrustedEvent()), /Unauthorized IPC sender/)
    assert.deepEqual(mockState.urls, [])
  })

  it("records the answer and makes the request for a trusted caller", async () => {
    await freshHandlers()
    const handler = getIpcHandler<AcceptHandler>(IPC_CHANNELS.NET_MANAGER.ACCEPT_MODDB_VISIBILITY)

    assert.equal(await handler(await createTrustedEvent()), true)
    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl(FILE_ID)])
    assert.equal(storedAnswer(), MODDB_VISIBILITY_ACCEPTED)
  })

  it("refuses a direct call that no unanswered prompt stands behind, and leaves the stored answer alone", async () => {
    // The channel is the only door to the counting endpoint, and it opens on one transition only:
    // a config with no answer becoming an accepted one. Anything else, including a caller invoking
    // it straight off the bridge after the question was settled, gets nothing.
    storeAnswer(MODDB_VISIBILITY_DECLINED)
    await freshHandlers()
    const handler = getIpcHandler<AcceptHandler>(IPC_CHANNELS.NET_MANAGER.ACCEPT_MODDB_VISIBILITY)

    assert.equal(await handler(await createTrustedEvent()), false)
    assert.deepEqual(mockState.urls, [])
    assert.equal(storedAnswer(), MODDB_VISIBILITY_DECLINED)
  })
})
