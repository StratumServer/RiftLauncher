import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { installMod, modArchiveFileName } from "../../../src/domain/mods/install"
import type { InstallModEvents, InstallModInput, InstallModPorts, ModReleaseToInstall } from "../../../src/domain/mods/install"
import type { DownloadOutcome, DownloadRequest, Downloader, FileSystem, PathBuilder } from "../../../src/domain/ports"

const INSTALLATION = "/installations/main"
const MODS_FOLDER = `${INSTALLATION}/Mods`

const RELEASE: ModReleaseToInstall = {
  mainfile: "https://mods.vintagestory.at/download?fileid=42",
  modidstr: "carryon",
  modversion: "2.0.1"
}

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

beforeEach(() => {
  trace = []
})

function fakeFileSystem(options: { removes?: boolean } = {}): FileSystem {
  return {
    exists: async (): Promise<boolean> => {
      throw new Error("The install flow must not ask what exists.")
    },
    remove: async (path: string): Promise<boolean> => {
      trace.push(`remove:${path}`)
      return options.removes ?? true
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

function fakePorts(overrides: Partial<InstallModPorts> = {}): InstallModPorts {
  return { fileSystem: fakeFileSystem(), paths: fakePaths, downloader: fakeDownloader().downloader, ...overrides }
}

function input(overrides: Partial<InstallModInput> = {}): InstallModInput {
  return { installationPath: INSTALLATION, release: RELEASE, ...overrides }
}

function recordingEvents(): InstallModEvents {
  return {
    onExistingRemoved: (path): void => {
      trace.push(`existing-removed:${path}`)
    },
    onDownloadStarted: (fileName): void => {
      trace.push(`download-started:${fileName}`)
    }
  }
}

describe("modArchiveFileName", () => {
  it("names an archive after its modid and version", () => {
    assert.equal(modArchiveFileName(RELEASE), "carryon-2.0.1.zip")
  })

  it("keeps the version verbatim, pre-release suffix included", () => {
    assert.equal(modArchiveFileName({ ...RELEASE, modversion: "2.0.0-pre.8" }), "carryon-2.0.0-pre.8.zip")
  })
})

describe("installMod", () => {
  it("downloads into the installation's Mods folder under the name the scan will read back", async () => {
    const { downloader, requests } = fakeDownloader()

    const result = await installMod(fakePorts({ downloader }), input())

    assert.deepEqual(requests, [{ url: RELEASE.mainfile, outputFolder: MODS_FOLDER, fileName: "carryon-2.0.1.zip" }])
    assert.deepEqual(result, { ok: true, fileName: "carryon-2.0.1.zip", path: `${MODS_FOLDER}/carryon-2.0.1.zip` })
  })

  it("removes the copy it replaces before fetching anything", async () => {
    await installMod(fakePorts(), input({ existing: { path: `${MODS_FOLDER}/carryon-1.9.0.zip`, version: "1.9.0" } }), recordingEvents())

    assert.deepEqual(trace, [
      `remove:${MODS_FOLDER}/carryon-1.9.0.zip`,
      `existing-removed:${MODS_FOLDER}/carryon-1.9.0.zip`,
      "download-started:carryon-2.0.1.zip",
      `download:${RELEASE.mainfile}->${MODS_FOLDER}/carryon-2.0.1.zip`
    ])
  })

  it("touches nothing when no copy is installed", async () => {
    await installMod(fakePorts(), input(), recordingEvents())

    assert.deepEqual(trace, ["download-started:carryon-2.0.1.zip", `download:${RELEASE.mainfile}->${MODS_FOLDER}/carryon-2.0.1.zip`])
  })

  it("refuses rather than stacking a second archive when the old one will not delete", async () => {
    const { downloader, requests } = fakeDownloader()

    const result = await installMod(fakePorts({ fileSystem: fakeFileSystem({ removes: false }), downloader }), input({ existing: { path: `${MODS_FOLDER}/carryon-1.9.0.zip`, version: "1.9.0" } }))

    assert.deepEqual(result, { ok: false, reason: "old-version-delete-failed" })
    assert.deepEqual(requests, [], "a refused deletion must not be followed by a download")
  })

  it("reports a failed download", async () => {
    const { downloader } = fakeDownloader({ outcome: { ok: false, error: "connection reset" } })

    assert.deepEqual(await installMod(fakePorts({ downloader }), input()), { ok: false, reason: "download-failed" })
  })

  it("treats a downloader that reports success without a path as a failure", async () => {
    const { downloader } = fakeDownloader({ outcome: { ok: true } })

    assert.deepEqual(await installMod(fakePorts({ downloader }), input()), { ok: false, reason: "download-failed" })
  })

  it("treats a downloader that never reports at all as a failure", async () => {
    const { downloader } = fakeDownloader({ silent: true })

    assert.deepEqual(await installMod(fakePorts({ downloader }), input()), { ok: false, reason: "download-failed" })
  })

  it("stops before touching the folder while a backup or a restore holds the installation", async () => {
    const { downloader, requests } = fakeDownloader()

    const result = await installMod(
      fakePorts({ fileSystem: fakeFileSystem(), downloader }),
      input({ installationBusy: true, existing: { path: `${MODS_FOLDER}/carryon-1.9.0.zip`, version: "1.9.0" } })
    )

    assert.deepEqual(result, { ok: false, reason: "installation-busy" })
    assert.deepEqual(trace, [])
    assert.deepEqual(requests, [])
  })
})
