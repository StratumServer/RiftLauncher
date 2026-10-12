import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { installMod, modArchiveFileName, modsFolderInUse } from "../../../src/domain/mods/install"
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

function fakeFileSystem(options: { removes?: boolean; refuses?: string[] } = {}): FileSystem {
  return {
    exists: async (): Promise<boolean> => {
      throw new Error("The install flow must not ask what exists.")
    },
    remove: async (path: string): Promise<boolean> => {
      trace.push(`remove:${path}`)
      if (options.refuses?.includes(path)) return false
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

  it("names a disabled install out of the game's way (#287)", () => {
    assert.equal(modArchiveFileName(RELEASE, true), "carryon-2.0.1.zip.disabled")
    assert.equal(modArchiveFileName(RELEASE, false), "carryon-2.0.1.zip")
  })
})

describe("installMod", () => {
  it("downloads into the installation's Mods folder under the name the scan will read back", async () => {
    const { downloader, requests } = fakeDownloader()

    const result = await installMod(fakePorts({ downloader }), input())

    assert.deepEqual(requests, [{ url: RELEASE.mainfile, outputFolder: MODS_FOLDER, fileName: "carryon-2.0.1.zip" }])
    assert.deepEqual(result, { ok: true, fileName: "carryon-2.0.1.zip", path: `${MODS_FOLDER}/carryon-2.0.1.zip` })
  })

  it("fetches the new archive first and removes the copy it replaces only once that archive is on disk (#703)", async () => {
    await installMod(fakePorts(), input({ existing: { path: `${MODS_FOLDER}/carryon-1.9.0.zip`, version: "1.9.0" } }), recordingEvents())

    assert.deepEqual(trace, [
      "download-started:carryon-2.0.1.zip",
      `download:${RELEASE.mainfile}->${MODS_FOLDER}/carryon-2.0.1.zip`,
      `remove:${MODS_FOLDER}/carryon-1.9.0.zip`,
      `existing-removed:${MODS_FOLDER}/carryon-1.9.0.zip`
    ])
  })

  it("touches nothing when no copy is installed", async () => {
    await installMod(fakePorts(), input(), recordingEvents())

    assert.deepEqual(trace, ["download-started:carryon-2.0.1.zip", `download:${RELEASE.mainfile}->${MODS_FOLDER}/carryon-2.0.1.zip`])
  })

  it("keeps the installed copy, and says so, when the download fails (#703)", async () => {
    const { downloader } = fakeDownloader({ outcome: { ok: false, error: "connection reset" } })

    const result = await installMod(fakePorts({ downloader }), input({ existing: { path: `${MODS_FOLDER}/carryon-1.9.0.zip`, version: "1.9.0" } }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "download-failed" })
    assert.deepEqual(
      trace.filter((step) => step.startsWith("remove:") || step.startsWith("existing-removed:")),
      [],
      "a failed download must not delete anything"
    )
  })

  it("keeps the installed copy when the downloader reports success without a path or never reports (#703)", async () => {
    for (const silent of [false, true]) {
      trace = []
      const { downloader } = fakeDownloader(silent ? { silent } : { outcome: { ok: true } })

      const result = await installMod(fakePorts({ downloader }), input({ existing: { path: `${MODS_FOLDER}/carryon-1.9.0.zip`, version: "1.9.0" } }))

      assert.deepEqual(result, { ok: false, reason: "download-failed" })
      assert.deepEqual(
        trace.filter((step) => step.startsWith("remove:")),
        []
      )
    }
  })

  it("takes the new archive back out rather than stacking a second one when the old one will not delete", async () => {
    const oldPath = `${MODS_FOLDER}/carryon-1.9.0.zip`
    const { downloader } = fakeDownloader()

    const result = await installMod(fakePorts({ fileSystem: fakeFileSystem({ refuses: [oldPath] }), downloader }), input({ existing: { path: oldPath, version: "1.9.0" } }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "old-version-delete-failed" })
    assert.deepEqual(trace, ["download-started:carryon-2.0.1.zip", `download:${RELEASE.mainfile}->${MODS_FOLDER}/carryon-2.0.1.zip`, `remove:${oldPath}`, `remove:${MODS_FOLDER}/carryon-2.0.1.zip`])
  })

  it("reports both versions left in the folder when the take-back fails too (#703)", async () => {
    const oldPath = `${MODS_FOLDER}/carryon-1.9.0.zip`
    const newPath = `${MODS_FOLDER}/carryon-2.0.1.zip`

    const result = await installMod(fakePorts({ fileSystem: fakeFileSystem({ refuses: [oldPath, newPath] }) }), input({ existing: { path: oldPath, version: "1.9.0" } }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "new-version-cleanup-failed" })
    assert.ok(!trace.some((entry) => entry.startsWith("existing-removed:")))
  })

  it("judges 'the copy is the new file' by where the download landed, not by the path joined here (#703)", async () => {
    // The scan and the main process spell the path one way, the renderer's join another.
    const landedAt = `${INSTALLATION}/./Mods/carryon-2.0.1.zip`

    const result = await installMod(
      fakePorts({ downloader: fakeDownloader({ outcome: { ok: true, filePath: landedAt } }).downloader }),
      input({ existing: { path: landedAt, version: "2.0.1" } }),
      recordingEvents()
    )

    assert.deepEqual(result, { ok: true, fileName: "carryon-2.0.1.zip", path: landedAt })
    assert.ok(!trace.some((entry) => entry.startsWith("remove:")))
  })

  it("does not delete the archive it just wrote when the copy being replaced is that very file (#703)", async () => {
    const samePath = `${MODS_FOLDER}/carryon-2.0.1.zip`

    const result = await installMod(fakePorts(), input({ existing: { path: samePath, version: "2.0.1" } }), recordingEvents())

    assert.deepEqual(result, { ok: true, fileName: "carryon-2.0.1.zip", path: samePath })
    assert.deepEqual(trace, ["download-started:carryon-2.0.1.zip", `download:${RELEASE.mainfile}->${samePath}`])
  })

  it("keeps the delete-first order for a copy whose path differs from the new one by letter case only (#703)", async () => {
    const sameFile = `${MODS_FOLDER}/CarryOn-2.0.1.zip`

    await installMod(fakePorts(), input({ existing: { path: sameFile, version: "2.0.1" } }), recordingEvents())

    // On a case-insensitive volume this is one file: a delete after the download would remove the new archive.
    assert.deepEqual(trace, [`remove:${sameFile}`, `existing-removed:${sameFile}`, "download-started:carryon-2.0.1.zip", `download:${RELEASE.mainfile}->${MODS_FOLDER}/carryon-2.0.1.zip`])
  })

  it("refuses a case-only copy that will not delete, without downloading", async () => {
    const sameFile = `${MODS_FOLDER}/CarryOn-2.0.1.zip`
    const { downloader, requests } = fakeDownloader()

    const result = await installMod(fakePorts({ fileSystem: fakeFileSystem({ refuses: [sameFile] }), downloader }), input({ existing: { path: sameFile, version: "2.0.1" } }))

    assert.deepEqual(result, { ok: false, reason: "old-version-delete-failed" })
    assert.deepEqual(requests, [])
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

  it("updates a disabled mod into a disabled archive, so it stays out of the load order (#287)", async () => {
    const { downloader, requests } = fakeDownloader()

    const result = await installMod(fakePorts({ downloader }), input({ existing: { path: `${MODS_FOLDER}/carryon-1.9.0.zip.disabled`, version: "1.9.0" }, disabled: true }))

    // The new one arrives under the same kind of name, then the old disabled copy goes. Asking for an
    // update is not asking for the mod to come back on.
    assert.deepEqual(requests, [{ url: RELEASE.mainfile, outputFolder: MODS_FOLDER, fileName: "carryon-2.0.1.zip.disabled" }])
    assert.deepEqual(result, { ok: true, fileName: "carryon-2.0.1.zip.disabled", path: `${MODS_FOLDER}/carryon-2.0.1.zip.disabled` })
    assert.deepEqual(trace, [`download:${RELEASE.mainfile}->${MODS_FOLDER}/carryon-2.0.1.zip.disabled`, `remove:${MODS_FOLDER}/carryon-1.9.0.zip.disabled`])
  })
})

describe("modsFolderInUse", () => {
  it("holds the folder during a backup, a restore or Update all, each on its own", () => {
    assert.equal(modsFolderInUse({ _backuping: true }), true)
    assert.equal(modsFolderInUse({ _restoringBackup: true }), true)
    assert.equal(modsFolderInUse({ _updatingMods: true }), true)
  })

  it("leaves the folder free when none of the three is set", () => {
    assert.equal(modsFolderInUse({}), false)
    assert.equal(modsFolderInUse({ _backuping: false, _restoringBackup: false, _updatingMods: false }), false)
  })
})
