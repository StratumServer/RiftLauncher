import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { installGameVersion } from "../../../src/domain/versions/install"
import type { DownloadableGameVersion, InstallGameVersionEvents, InstallGameVersionInput, InstallGameVersionPorts } from "../../../src/domain/versions/install"
import type { DownloadOutcome, DownloadRequest, Downloader, FileSystem, PathBuilder, UnpackOutcome, UnpackRequest, Unpacker } from "../../../src/domain/ports"

const VERSION = "1.20.4"
const TARGET = "/games/1.20.4"
const DOWNLOADED = `${TARGET}/${VERSION}`
const WINDOWS_URL = "https://cdn.vintagestory.at/1.20.4.exe"
const MAC_URL = "https://cdn.vintagestory.at/1.20.4-mac.tar.gz"
const LINUX_URL = "https://cdn.vintagestory.at/1.20.4-linux.tar.gz"

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

const catalogEntry: DownloadableGameVersion = {
  version: VERSION,
  downloads: { win32: WINDOWS_URL, darwin: MAC_URL, linux: LINUX_URL }
}

/** A file system that remembers what is on disk, so verification has something real to read. */
function fakeFileSystem(present: string[] = []): FileSystem & { disk: Set<string> } {
  const disk = new Set(present)

  return {
    disk,
    exists: async (path: string): Promise<boolean> => {
      trace.push(`exists:${path}`)
      return disk.has(path)
    },
    remove: async (): Promise<boolean> => {
      throw new Error("The install flow must not delete anything.")
    },
    move: async (): Promise<boolean> => {
      throw new Error("The install flow must not move anything.")
    }
  }
}

const fakePaths: PathBuilder = { join: async (parts: string[]): Promise<string> => parts.join("/") }

function fakeDownloader(options: { outcome?: DownloadOutcome; silent?: boolean } = {}): { downloader: Downloader; requests: DownloadRequest[] } {
  const requests: DownloadRequest[] = []
  const downloader: Downloader = {
    download: async (request: DownloadRequest, onComplete: (outcome: DownloadOutcome) => void): Promise<void> => {
      trace.push(`download:${request.url}->${request.outputFolder}/${request.fileName}`)
      requests.push(request)
      if (!options.silent) onComplete(options.outcome ?? { ok: true, filePath: `${request.outputFolder}/${request.fileName}` })
    }
  }
  return { downloader, requests }
}

/** An unpacker that can put the game on disk, so a test can tell a real install from a reported one. */
function fakeUnpacker(options: { outcome?: UnpackOutcome; silent?: boolean; disk?: Set<string>; lands?: string[] } = {}): { unpacker: Unpacker; requests: UnpackRequest[] } {
  const requests: UnpackRequest[] = []

  const run = (mechanism: string) => {
    return async (request: UnpackRequest, onComplete: (outcome: UnpackOutcome) => void): Promise<void> => {
      trace.push(`${mechanism}:${request.sourcePath}->${request.outputFolder}`)
      requests.push(request)
      for (const file of options.lands ?? []) options.disk?.add(`${request.outputFolder}/${file}`)
      if (!options.silent) onComplete(options.outcome ?? { ok: true })
    }
  }

  return { unpacker: { extractArchive: run("extract"), runInstaller: run("run-installer") }, requests }
}

function fakePorts(overrides: Partial<InstallGameVersionPorts> = {}): InstallGameVersionPorts {
  return {
    fileSystem: fakeFileSystem(),
    paths: fakePaths,
    downloader: fakeDownloader().downloader,
    unpacker: fakeUnpacker().unpacker,
    ...overrides
  }
}

function input(overrides: Partial<InstallGameVersionInput> = {}): InstallGameVersionInput {
  return {
    platform: "linux",
    version: catalogEntry,
    targetFolder: TARGET,
    installedVersions: [],
    foldersInUse: [],
    ...overrides
  }
}

function recordingEvents(): InstallGameVersionEvents {
  return {
    onRegistered: (): void => {
      trace.push("registered")
    },
    onInstalled: (): void => {
      trace.push("installed")
    },
    onDiscarded: (reason): void => {
      trace.push(`discarded:${reason}`)
    }
  }
}

/** Ports whose unpacking leaves a working game behind, which is the only way to reach success. */
function landingPorts(lands: string[]): { ports: InstallGameVersionPorts; disk: Set<string> } {
  const fileSystem = fakeFileSystem()
  const { unpacker } = fakeUnpacker({ disk: fileSystem.disk, lands })
  return { ports: fakePorts({ fileSystem, unpacker }), disk: fileSystem.disk }
}

beforeEach(() => {
  trace = []
})

describe("installGameVersion preconditions", () => {
  it("refuses a version the launcher already has", async () => {
    const result = await installGameVersion(fakePorts(), input({ installedVersions: ["1.20.3", VERSION] }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "version-already-installed" })
    assert.deepEqual(trace, [])
  })

  it("refuses a folder the launcher already uses for something else", async () => {
    const result = await installGameVersion(fakePorts(), input({ foldersInUse: ["/backups", TARGET] }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "folder-in-use" })
    assert.deepEqual(trace, [])
  })

  it("names a platform the catalog has no build for instead of downloading nothing", async () => {
    const version: DownloadableGameVersion = { version: VERSION, downloads: { win32: WINDOWS_URL, darwin: "", linux: LINUX_URL } }

    const result = await installGameVersion(fakePorts(), input({ platform: "darwin", version }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "no-download-for-os" })
    assert.deepEqual(trace, [])
  })

  it("registers nothing when a precondition fails", async () => {
    await installGameVersion(fakePorts(), input({ installedVersions: [VERSION] }), recordingEvents())

    assert.equal(trace.includes("registered"), false)
    assert.equal(
      trace.some((entry) => entry.startsWith("discarded:")),
      false
    )
  })
})

describe("installGameVersion happy path", () => {
  it("downloads then extracts the archive on Linux, and only then calls it installed", async () => {
    const { ports, disk } = landingPorts(["Vintagestory"])

    const result = await installGameVersion(ports, input(), recordingEvents())

    assert.deepEqual(result, { ok: true, path: TARGET })
    assert.deepEqual(trace, ["registered", `download:${LINUX_URL}->${TARGET}/${VERSION}`, `extract:${DOWNLOADED}->${TARGET}`, `exists:${TARGET}/Vintagestory`, "installed"])
    assert.equal(disk.has(`${TARGET}/Vintagestory`), true)
  })

  it("downloads then runs the installer on Windows", async () => {
    const { ports } = landingPorts(["Vintagestory.exe"])

    const result = await installGameVersion(ports, input({ platform: "win32" }), recordingEvents())

    assert.deepEqual(result, { ok: true, path: TARGET })
    assert.deepEqual(trace, ["registered", `download:${WINDOWS_URL}->${TARGET}/${VERSION}`, `run-installer:${DOWNLOADED}->${TARGET}`, `exists:${TARGET}/Vintagestory.exe`, "installed"])
  })

  it("never runs the Windows installer on a platform that ships an archive", async () => {
    const fileSystem = fakeFileSystem()
    const { unpacker, requests } = fakeUnpacker({ disk: fileSystem.disk, lands: ["Vintagestory"] })

    await installGameVersion(fakePorts({ fileSystem, unpacker }), input({ platform: "freebsd" }), recordingEvents())

    assert.equal(requests.length, 1)
    assert.equal(
      trace.some((entry) => entry.startsWith("run-installer:")),
      false
    )
  })

  it("unpacks the file the download reported, not a path of its own making", async () => {
    const fileSystem = fakeFileSystem()
    const { downloader } = fakeDownloader({ outcome: { ok: true, filePath: "/tmp/somewhere-else.tar.gz" } })
    const { unpacker, requests } = fakeUnpacker({ disk: fileSystem.disk, lands: ["Vintagestory"] })

    await installGameVersion(fakePorts({ fileSystem, downloader, unpacker }), input())

    assert.equal(requests[0]?.sourcePath, "/tmp/somewhere-else.tar.gz")
    assert.equal(requests[0]?.outputFolder, TARGET)
  })

  it("falls back to the mono executable when the native Linux launcher is absent", async () => {
    const { ports } = landingPorts(["Vintagestory.exe"])

    const result = await installGameVersion(ports, input(), recordingEvents())

    assert.deepEqual(result, { ok: true, path: TARGET })
    assert.deepEqual(trace.slice(-3), [`exists:${TARGET}/Vintagestory`, `exists:${TARGET}/Vintagestory.exe`, "installed"])
  })

  it("accepts a macOS install without checking, because there is no expectation to check", async () => {
    const version: DownloadableGameVersion = { version: VERSION, downloads: { win32: WINDOWS_URL, darwin: MAC_URL, linux: LINUX_URL } }
    const { ports } = landingPorts([])

    const result = await installGameVersion(ports, input({ platform: "darwin", version }), recordingEvents())

    assert.deepEqual(result, { ok: true, path: TARGET })
    assert.equal(
      trace.some((entry) => entry.startsWith("exists:")),
      false
    )
  })
})

describe("installGameVersion failure tree", () => {
  it("names a failed download and takes the version back off the list", async () => {
    const { downloader } = fakeDownloader({ outcome: { ok: false, error: "connection reset" } })

    const result = await installGameVersion(fakePorts({ downloader }), input(), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "download-failed" })
    assert.deepEqual(trace, ["registered", `download:${LINUX_URL}->${TARGET}/${VERSION}`, "discarded:download-failed"])
  })

  it("treats a downloader that never reports as a failed download", async () => {
    const { downloader } = fakeDownloader({ silent: true })

    const result = await installGameVersion(fakePorts({ downloader }), input())

    assert.deepEqual(result, { ok: false, reason: "download-failed" })
  })

  it("treats a download that reports success without a file as a failed download", async () => {
    const { downloader } = fakeDownloader({ outcome: { ok: true } })

    const result = await installGameVersion(fakePorts({ downloader }), input(), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "download-failed" })
    assert.equal(
      trace.some((entry) => entry.startsWith("extract:")),
      false
    )
  })

  it("names a failed extraction apart from a failed download", async () => {
    const { unpacker } = fakeUnpacker({ outcome: { ok: false, error: "corrupt archive" } })

    const result = await installGameVersion(fakePorts({ unpacker }), input(), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "unpack-failed" })
    assert.deepEqual(trace, ["registered", `download:${LINUX_URL}->${TARGET}/${VERSION}`, `extract:${DOWNLOADED}->${TARGET}`, "discarded:unpack-failed"])
  })

  it("names a failed Windows installer as an unpacking failure", async () => {
    const { unpacker } = fakeUnpacker({ outcome: { ok: false, error: "installer exited with 2" } })

    const result = await installGameVersion(fakePorts({ unpacker }), input({ platform: "win32" }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "unpack-failed" })
    assert.equal(trace.includes(`run-installer:${DOWNLOADED}->${TARGET}`), true)
  })

  it("treats an unpacker that never reports as a failed unpacking", async () => {
    const { unpacker } = fakeUnpacker({ silent: true })

    const result = await installGameVersion(fakePorts({ unpacker }), input())

    assert.deepEqual(result, { ok: false, reason: "unpack-failed" })
  })

  it("reports an installer that claimed success but left the folder empty", async () => {
    const { ports } = landingPorts([])

    const result = await installGameVersion(ports, input({ platform: "win32" }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "game-executable-missing" })
    assert.deepEqual(trace, [
      "registered",
      `download:${WINDOWS_URL}->${TARGET}/${VERSION}`,
      `run-installer:${DOWNLOADED}->${TARGET}`,
      `exists:${TARGET}/Vintagestory.exe`,
      "discarded:game-executable-missing"
    ])
  })

  it("reports an installer that wrote the game somewhere else entirely", async () => {
    const fileSystem = fakeFileSystem(["/games/somewhere-else/Vintagestory.exe"])
    const { unpacker } = fakeUnpacker({ disk: fileSystem.disk })

    const result = await installGameVersion(fakePorts({ fileSystem, unpacker }), input({ platform: "win32" }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "game-executable-missing" })
    assert.equal(trace.includes("installed"), false)
  })

  it("reports an extraction that produced neither Linux executable", async () => {
    const { ports } = landingPorts(["readme.txt"])

    const result = await installGameVersion(ports, input(), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "game-executable-missing" })
    assert.deepEqual(trace.slice(-3), [`exists:${TARGET}/Vintagestory`, `exists:${TARGET}/Vintagestory.exe`, "discarded:game-executable-missing"])
  })

  it("never reports both an outcome and its opposite", async () => {
    const { ports } = landingPorts([])

    await installGameVersion(ports, input(), recordingEvents())

    assert.equal(trace.filter((entry) => entry === "installed").length, 0)
    assert.equal(trace.filter((entry) => entry.startsWith("discarded:")).length, 1)
  })
})
