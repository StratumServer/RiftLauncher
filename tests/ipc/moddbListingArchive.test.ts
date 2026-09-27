import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronAppVersion, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { MAX_MODDB_LISTING_RESPONSE_BYTES } from "@src/ipc/validation"
import { MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl, MODDB_VISIBILITY_ALWAYS, MODDB_VISIBILITY_NEVER, MODDB_VISIBILITY_ONCE } from "@domain/moddbVisibility"

/**
 * COUNT_MODDB_DOWNLOAD (src/ipc/handlers/netHandlers.ts), the one request the ModDB visibility
 * prompt makes when a player says yes (#219), now aimed at the listing entry named for the version
 * they are running rather than at whichever entry is newest (#477), and the config writes that
 * bracket it.
 *
 * The transport is mocked, the way tests/ipc/backgroundHandlers.test.ts mocks it, so the two URLs
 * and their order are observable: the file id has to be resolved from the API before the download
 * endpoint is touched, because that endpoint is the only thing that increments a counter and the
 * wrong id would count towards the wrong entry.
 *
 * configManager.ts is not mocked. The point of these tests is what a later launch reads back, which
 * a fake store would assert about itself rather than about the file, so the temp userData folder
 * holds a real config.json throughout.
 *
 * `vi.resetModules()` between tests because netHandlers.ts keeps the "already tried this process"
 * flag in module state, which is the point of it: without a fresh module every test would be
 * measuring the first one's guard. Re-importing it against the same temp folder is also what a
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

/** The version the tests run as, and the entry the listing names for it. */
const RUNNING_VERSION = "1.7.0-beta.10"
const LISTING_VERSION = "1.7.0-pre.10"
const FILE_ID = 122116
const PREVIOUS_FILE_ID = 120952

/** A `/api/mod/11016` body carrying two entries, newest first, the way the API serves them. */
function listingDetail(
  releases: unknown[] = [
    { releaseid: 9, fileid: FILE_ID, modversion: LISTING_VERSION },
    { releaseid: 8, fileid: PREVIOUS_FILE_ID, modversion: "1.7.0-pre.9" }
  ]
): string {
  return JSON.stringify({ statuscode: "200", mod: { modid: 11016, name: "RiftLauncher", releases } })
}

let userDataFolder: string

type CountHandler = (event: IpcMainInvokeEvent, consent: unknown) => Promise<ModDbCountResult>

/** A netHandlers.ts with its once-per-process flag unset, plus the functions the IPC handler delegates to. */
async function freshHandlers(): Promise<typeof import("@src/ipc/handlers/netHandlers")> {
  vi.resetModules()
  return import("@src/ipc/handlers/netHandlers")
}

/** The ModDB answer sitting in the temp folder's config.json, or undefined when there is no config there. */
function storedVisibility(): ConfigType["moddbVisibility"] | undefined {
  try {
    return JSON.parse(readFileSync(join(userDataFolder, "config.json"), "utf-8")).moddbVisibility
  } catch {
    return undefined
  }
}

/** Puts a config carrying `visibility` on disk, the way a launch that was already answered would find it. */
function storeVisibility(visibility: Partial<ConfigType["moddbVisibility"]>): void {
  writeFileSync(join(userDataFolder, "config.json"), JSON.stringify({ schemaVersion: 5, moddbVisibility: { policy: "ask", answeredVersion: "", countedVersions: [], ...visibility } }))
}

beforeEach(() => {
  userDataFolder = mkdtempSync(join(tmpdir(), "moddb-listing-archive-"))
  setElectronUserDataPath(userDataFolder)
  setElectronAppVersion(RUNNING_VERSION)
  mockState.urls.length = 0
  mockState.logLines.length = 0
  mockState.requestBoundedText.mockReset()
  mockState.requestBoundedBuffer.mockReset()
  mockState.requestBoundedText.mockResolvedValue(listingDetail())
  mockState.requestBoundedBuffer.mockResolvedValue(Buffer.from("pointer archive"))
})

afterEach(() => {
  rmSync(userDataFolder, { recursive: true, force: true })
  setElectronAppVersion()
  vi.resetModules()
})

describe("fetchModDbListingArchive", () => {
  it("resolves the entry named for the version from the API before it touches the counting endpoint", async () => {
    const { fetchModDbListingArchive } = await freshHandlers()

    assert.equal(await fetchModDbListingArchive(LISTING_VERSION), "counted")
    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl(FILE_ID)])
  })

  it("counts the version's own entry rather than whichever one is newest", async () => {
    const { fetchModDbListingArchive } = await freshHandlers()

    await fetchModDbListingArchive("1.7.0-pre.9")
    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl(PREVIOUS_FILE_ID)])
  })

  it("caps the download, which must never be a way to pull a real file", async () => {
    const { fetchModDbListingArchive } = await freshHandlers()
    await fetchModDbListingArchive(LISTING_VERSION)

    const [, options] = mockState.requestBoundedBuffer.mock.calls[0] ?? []
    assert.deepEqual(options, { maxBytes: MAX_MODDB_LISTING_RESPONSE_BYTES })
  })

  it("answers no-entry, and requests nothing, for a version the listing has not caught up with", async () => {
    // The entry is uploaded after the GitHub release, so this is the ordinary state of the first
    // launches of a beta rather than a failure.
    const { fetchModDbListingArchive } = await freshHandlers()

    assert.equal(await fetchModDbListingArchive("1.7.0-pre.11"), "no-entry")
    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL])
  })

  it("answers unreachable when the API cannot be reached, and never guesses a file id", async () => {
    mockState.requestBoundedText.mockRejectedValue(new Error("network down"))
    const { fetchModDbListingArchive } = await freshHandlers()

    assert.equal(await fetchModDbListingArchive(LISTING_VERSION), "unreachable")
    assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 0)
  })

  it("answers unreachable on an application error the API dressed up as HTTP 200", async () => {
    // A listing that could not be read says nothing about whether the entry exists, so this must
    // not read as no-entry: one is retried on a later launch, and so is the other.
    mockState.requestBoundedText.mockResolvedValue(JSON.stringify({ statuscode: "404" }))
    const { fetchModDbListingArchive } = await freshHandlers()

    assert.equal(await fetchModDbListingArchive(LISTING_VERSION), "unreachable")
    assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 0)
  })

  it("answers unreachable on a failed download, since this is a courtesy and not a task anyone is waiting on", async () => {
    mockState.requestBoundedBuffer.mockRejectedValue(new Error("refused"))
    const { fetchModDbListingArchive } = await freshHandlers()

    assert.equal(await fetchModDbListingArchive(LISTING_VERSION), "unreachable")
  })

  it("reads the refused redirect as the counted outcome rather than as a failure", async () => {
    // ModDB answers the counting endpoint with a 302 and the transport refuses to follow it, so
    // this rejection is what success looks like here. Logging it like any other error sends the
    // next person debugging something else down a false trail.
    mockState.requestBoundedBuffer.mockRejectedValue(new Error("Attempted to redirect, but redirect policy was 'error'"))
    const { fetchModDbListingArchive } = await freshHandlers()

    assert.equal(await fetchModDbListingArchive(LISTING_VERSION), "counted")
    assert.equal(
      mockState.logLines.some((line) => line.includes("counted outcome")),
      true,
      `expected the counted-outcome line, got ${JSON.stringify(mockState.logLines)}`
    )
  })

  it("does not read a redirect out of the detail request as a count, since nothing was requested yet", async () => {
    // The detail request runs before any file id exists, so it cannot have registered anything. A
    // redirect there means the API moved. Calling it counted would put a download in the log that
    // never happened, and would quietly retire the question on a launch that achieved nothing.
    mockState.requestBoundedText.mockRejectedValue(new Error("Attempted to redirect, but redirect policy was 'error'"))
    const { fetchModDbListingArchive } = await freshHandlers()

    assert.equal(await fetchModDbListingArchive(LISTING_VERSION), "unreachable")
    assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 0)
    assert.equal(
      mockState.logLines.some((line) => line.includes("counted outcome")),
      false,
      `expected no counted-outcome line, got ${JSON.stringify(mockState.logLines)}`
    )
  })
})

describe("countModDbDownload", () => {
  it("asks the listing for the entry named after the running version", async () => {
    const { countModDbDownload } = await freshHandlers()

    assert.equal((await countModDbDownload(MODDB_VISIBILITY_ONCE)).reason, "counted")
    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl(FILE_ID)])
  })

  it("has the answer on disk before it touches the counting endpoint", async () => {
    const { countModDbDownload } = await freshHandlers()

    // The transport records what it could read at the moment it was called, which is the only way
    // to see the ordering rather than just the end state.
    let answerWhenRequested: ConfigType["moddbVisibility"] | undefined
    mockState.requestBoundedBuffer.mockImplementation(async () => {
      answerWhenRequested = storedVisibility()
      return Buffer.from("pointer archive")
    })

    await countModDbDownload(MODDB_VISIBILITY_ALWAYS)
    assert.equal(answerWhenRequested?.policy, MODDB_VISIBILITY_ALWAYS)
    assert.equal(answerWhenRequested?.answeredVersion, RUNNING_VERSION)
    // Not counted yet at that point: only an endpoint that answered may record one.
    assert.deepEqual(answerWhenRequested?.countedVersions, [])
  })

  it("records the version as counted once the endpoint has answered, and answers with what it wrote", async () => {
    const { countModDbDownload } = await freshHandlers()
    const result = await countModDbDownload(MODDB_VISIBILITY_ONCE)

    assert.deepEqual(result.visibility.countedVersions, [RUNNING_VERSION])
    assert.deepEqual(storedVisibility()?.countedVersions, [RUNNING_VERSION])
  })

  it("records nothing as counted when the listing has no entry yet, and a later launch finishes the job", async () => {
    mockState.requestBoundedText.mockResolvedValue(listingDetail([{ releaseid: 8, fileid: PREVIOUS_FILE_ID, modversion: "1.7.0-pre.9" }]))
    const firstLaunch = await freshHandlers()

    const result = await firstLaunch.countModDbDownload(MODDB_VISIBILITY_ONCE)
    assert.equal(result.reason, "no-entry")
    assert.deepEqual(result.visibility.countedVersions, [])
    // The answer is still on disk, so the prompt does not come back for this version.
    assert.equal(storedVisibility()?.answeredVersion, RUNNING_VERSION)

    // The entry has been uploaded by the time the player launches again.
    mockState.requestBoundedText.mockResolvedValue(listingDetail())
    mockState.urls.length = 0
    const secondLaunch = await freshHandlers()

    assert.equal((await secondLaunch.countModDbDownload(null)).reason, "counted")
    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl(FILE_ID)])
    assert.deepEqual(storedVisibility()?.countedVersions, [RUNNING_VERSION])
  })

  it("counts a stored always silently, with no answer to give", async () => {
    storeVisibility({ policy: MODDB_VISIBILITY_ALWAYS, answeredVersion: "1.7.0-beta.9", countedVersions: ["1.7.0-beta.9"] })
    const { countModDbDownload } = await freshHandlers()

    assert.equal((await countModDbDownload(null)).reason, "counted")
    assert.deepEqual(storedVisibility()?.countedVersions, ["1.7.0-beta.9", RUNNING_VERSION])
  })

  it("refuses a silent count that no stored answer stands behind, and leaves the answer alone", async () => {
    // The channel is the only door to the counting endpoint, and a caller invoking it straight off
    // the bridge with no answer to offer gets nothing.
    storeVisibility({ policy: MODDB_VISIBILITY_NEVER, answeredVersion: "1.7.0-beta.9" })
    const { countModDbDownload } = await freshHandlers()

    assert.equal((await countModDbDownload(null)).reason, "not-allowed")
    assert.deepEqual(mockState.urls, [])
    assert.equal(storedVisibility()?.policy, MODDB_VISIBILITY_NEVER)
  })

  it("reads a consent that is not one of the two yes answers as no consent at all", async () => {
    const { countModDbDownload } = await freshHandlers()

    for (const consent of ["never", "ask", "ALWAYS", true, 1, {}, ["always"]]) {
      assert.equal((await countModDbDownload(consent)).reason, "not-allowed", JSON.stringify(consent))
    }

    assert.deepEqual(mockState.urls, [])
    assert.equal(storedVisibility()?.policy, "ask")
    assert.equal(storedVisibility()?.answeredVersion, "")
  })

  it("tries once per launch, whatever asks it to", async () => {
    const { countModDbDownload } = await freshHandlers()

    assert.equal((await countModDbDownload(MODDB_VISIBILITY_ONCE)).reason, "counted")
    assert.equal((await countModDbDownload(MODDB_VISIBILITY_ONCE)).reason, "not-allowed")
    assert.equal((await countModDbDownload(null)).reason, "not-allowed")
    assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 1)
  })

  it("shares concurrent count attempts so one version cannot be counted twice", async () => {
    const { countModDbDownload } = await freshHandlers()
    let releaseDownload!: (value: Buffer) => void
    mockState.requestBoundedBuffer.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDownload = resolve
        })
    )

    const first = countModDbDownload(MODDB_VISIBILITY_ONCE)
    const second = countModDbDownload(MODDB_VISIBILITY_ONCE)

    await vi.waitFor(() => assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 1))
    releaseDownload(Buffer.from("pointer archive"))

    assert.equal((await first).reason, "counted")
    assert.equal((await second).reason, "counted")
    assert.equal(mockState.requestBoundedBuffer.mock.calls.length, 1)
  })

  it("does not retry inside the launch that could not reach the listing", async () => {
    mockState.requestBoundedText.mockRejectedValue(new Error("network down"))
    const { countModDbDownload } = await freshHandlers()

    assert.equal((await countModDbDownload(MODDB_VISIBILITY_ALWAYS)).reason, "unreachable")
    assert.equal((await countModDbDownload(null)).reason, "not-allowed")
    assert.equal(mockState.requestBoundedText.mock.calls.length, 1)
  })

  it("counts a version once across a relaunch, since what was counted outlives the process", async () => {
    const firstLaunch = await freshHandlers()
    assert.equal((await firstLaunch.countModDbDownload(MODDB_VISIBILITY_ALWAYS)).reason, "counted")

    mockState.urls.length = 0
    const secondLaunch = await freshHandlers()

    assert.equal((await secondLaunch.countModDbDownload(null)).reason, "not-allowed")
    assert.deepEqual(mockState.urls, [])
    assert.deepEqual(storedVisibility()?.countedVersions, [RUNNING_VERSION])
  })

  it("counts the next version for a player who said always, without asking again", async () => {
    const firstLaunch = await freshHandlers()
    await firstLaunch.countModDbDownload(MODDB_VISIBILITY_ALWAYS)

    setElectronAppVersion("1.7.0-beta.11")
    mockState.requestBoundedText.mockResolvedValue(listingDetail([{ releaseid: 10, fileid: 130000, modversion: "1.7.0-pre.11" }]))
    mockState.urls.length = 0
    const nextVersion = await freshHandlers()

    assert.equal((await nextVersion.countModDbDownload(null)).reason, "counted")
    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl(130000)])
    assert.deepEqual(storedVisibility()?.countedVersions, [RUNNING_VERSION, "1.7.0-beta.11"])
  })

  it("requests nothing when the answer cannot be written, and records nothing either", async () => {
    // A userData folder that does not exist, so every write into it fails the way a full or
    // read-only disk would.
    setElectronUserDataPath(join(userDataFolder, "not-a-folder"))
    const { countModDbDownload } = await freshHandlers()

    assert.equal((await countModDbDownload(MODDB_VISIBILITY_ONCE)).reason, "not-saved")
    assert.deepEqual(mockState.urls, [])
    assert.equal(storedVisibility(), undefined)
  })
})

describe("COUNT_MODDB_DOWNLOAD ipcMain.handle wrapper", () => {
  it("refuses an untrusted caller before making any request", async () => {
    await freshHandlers()
    const handler = getIpcHandler<CountHandler>(IPC_CHANNELS.NET_MANAGER.COUNT_MODDB_DOWNLOAD)

    await assert.rejects(() => handler(createUntrustedEvent(), MODDB_VISIBILITY_ONCE), /Unauthorized IPC sender/)
    assert.deepEqual(mockState.urls, [])
    assert.equal(storedVisibility(), undefined)
  })

  it("records the answer and makes the request for a trusted caller", async () => {
    await freshHandlers()
    const handler = getIpcHandler<CountHandler>(IPC_CHANNELS.NET_MANAGER.COUNT_MODDB_DOWNLOAD)

    assert.equal((await handler(await createTrustedEvent(), MODDB_VISIBILITY_ONCE)).reason, "counted")
    assert.deepEqual(mockState.urls, [MODDB_LISTING_DETAIL_URL, moddbListingDownloadUrl(FILE_ID)])
    assert.deepEqual(storedVisibility()?.countedVersions, [RUNNING_VERSION])
  })

  it("logs the outcome as a token, never a URL or a response", async () => {
    await freshHandlers()
    const handler = getIpcHandler<CountHandler>(IPC_CHANNELS.NET_MANAGER.COUNT_MODDB_DOWNLOAD)
    await handler(await createTrustedEvent(), MODDB_VISIBILITY_ONCE)

    const line = mockState.logLines.find((entry) => entry.includes("ModDB listing count for this version"))
    assert.ok(line, `expected the outcome line, got ${JSON.stringify(mockState.logLines)}`)
    assert.equal(line.endsWith("counted."), true, line)
    assert.equal(
      mockState.logLines.some((entry) => entry.includes("mods.vintagestory.at")),
      false,
      `a URL reached the log: ${JSON.stringify(mockState.logLines)}`
    )
  })
})
