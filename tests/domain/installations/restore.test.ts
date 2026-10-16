import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { restoreInstallationBackup } from "../../../src/domain/installations/restore"
import type { RestoreInstallationBackupEvents, RestoreInstallationBackupPorts } from "../../../src/domain/installations/restore"
import type { BackupRecord, InstallationSnapshot } from "../../../src/domain/installations/backup"
import type { ExtractOutcome, ExtractRequest, Extractor, FileSystem, InstallationLease, InstallationLeaseOutcome } from "../../../src/domain/ports"

const TOKEN = "token-1"
const INSTALLATION_PATH = "/games/my-install"
const STAGING_PATH = `${INSTALLATION_PATH}-restoring-${TOKEN}`
const REPLACED_PATH = `${INSTALLATION_PATH}-replaced-${TOKEN}`
const ARCHIVE_PATH = "/backups/my-install.tar.gz"

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

/**
 * A file system that remembers what is on disk, so a test can assert the
 * installation folder survived instead of only counting calls.
 */
function fakeFileSystem(options: { present?: string[]; failedMoves?: string[]; failedRemovals?: string[]; throwOnRemove?: string } = {}): FileSystem & { disk: Set<string> } {
  const disk = new Set(options.present ?? [INSTALLATION_PATH, ARCHIVE_PATH])
  const failedMoves = options.failedMoves ?? []
  const failedRemovals = options.failedRemovals ?? []

  return {
    disk,
    exists: async (path: string): Promise<boolean> => {
      trace.push(`exists:${path}`)
      return disk.has(path)
    },
    remove: async (path: string): Promise<boolean> => {
      trace.push(`remove:${path}`)
      if (options.throwOnRemove === path) throw new Error("the host blew up")
      if (failedRemovals.includes(path)) return false
      disk.delete(path)
      return true
    },
    move: async (from: string, to: string): Promise<boolean> => {
      trace.push(`move:${from}->${to}`)
      if (failedMoves.includes(from)) return false
      disk.delete(from)
      disk.add(to)
      return true
    }
  }
}

function fakeExtractor(options: { outcome?: ExtractOutcome; silent?: boolean; disk?: Set<string> } = {}): { extractor: Extractor; requests: ExtractRequest[] } {
  const requests: ExtractRequest[] = []
  const extractor: Extractor = {
    extract: async (request: ExtractRequest, onComplete: (outcome: ExtractOutcome) => void): Promise<void> => {
      trace.push(`extract:${request.archivePath}->${request.outputFolder}`)
      requests.push(request)
      // A real extraction leaves the output folder behind even when it fails.
      options.disk?.add(request.outputFolder)
      if (!options.silent) onComplete(options.outcome ?? { ok: true })
    }
  }
  return { extractor, requests }
}

/** A lease that always grants and says nothing; the tests that care about it pass their own. */
const grantedLease: InstallationLease = { acquire: async (): Promise<InstallationLeaseOutcome> => ({ ok: true, release: (): void => {} }) }

function fakePorts(overrides: Partial<RestoreInstallationBackupPorts> = {}): RestoreInstallationBackupPorts {
  return {
    fileSystem: fakeFileSystem(),
    extractor: fakeExtractor().extractor,
    ids: { newId: (): string => TOKEN },
    closeGuard: {
      acquire: (reason: string) => {
        trace.push(`guard-acquire:${reason}`)
        return (): void => {
          trace.push("guard-release")
        }
      }
    },
    installationLease: grantedLease,
    ...overrides
  }
}

function snapshot(overrides: Partial<InstallationSnapshot> = {}): InstallationSnapshot {
  return {
    id: "installation-1",
    name: "My Install",
    path: INSTALLATION_PATH,
    backupsLimit: 3,
    compressionLevel: 5,
    backups: [],
    isBackingUp: false,
    isPlaying: false,
    isRestoringBackup: false,
    ...overrides
  }
}

const archive: BackupRecord = { id: "backup-1", date: 1, path: ARCHIVE_PATH }

function recordingEvents(): RestoreInstallationBackupEvents {
  return {
    onStarted: (): void => {
      trace.push("started")
    },
    onFinished: (): void => {
      trace.push("finished")
    },
    onTemporaryFolderLeft: (path): void => {
      trace.push(`left:${path}`)
    }
  }
}

beforeEach(() => {
  trace = []
})

describe("restoreInstallationBackup preconditions", () => {
  it("refuses an installation that is being backed up", async () => {
    const result = await restoreInstallationBackup(fakePorts(), { installation: snapshot({ isBackingUp: true }), backup: archive })

    assert.deepEqual(result, { ok: false, reason: "installation-busy", strandedPath: null })
    assert.deepEqual(trace, [])
  })

  it("refuses an installation that is running", async () => {
    const result = await restoreInstallationBackup(fakePorts(), { installation: snapshot({ isPlaying: true }), backup: archive })

    assert.equal(result.ok === false && result.reason, "installation-playing")
  })

  it("refuses an installation that is already restoring", async () => {
    const result = await restoreInstallationBackup(fakePorts(), { installation: snapshot({ isRestoringBackup: true }), backup: archive })

    assert.equal(result.ok === false && result.reason, "restore-in-progress")
  })

  it("names a missing archive instead of starting the swap", async () => {
    const fileSystem = fakeFileSystem({ present: [INSTALLATION_PATH] })

    const result = await restoreInstallationBackup(fakePorts({ fileSystem }), { installation: snapshot(), backup: archive }, recordingEvents())

    assert.equal(result.ok === false && result.reason, "backup-file-missing")
    assert.deepEqual(trace, [`exists:${ARCHIVE_PATH}`])
    assert.equal(fileSystem.disk.has(INSTALLATION_PATH), true)
  })

  it("never touches the close guard when a precondition fails", async () => {
    await restoreInstallationBackup(fakePorts(), { installation: snapshot({ isPlaying: true }), backup: archive }, recordingEvents())

    assert.equal(
      trace.some((entry) => entry.startsWith("guard-")),
      false
    )
    assert.equal(trace.includes("started"), false)
  })
})

describe("restoreInstallationBackup happy path", () => {
  it("extracts beside the installation, swaps, then deletes the old folder last", async () => {
    const fileSystem = fakeFileSystem()
    const { extractor } = fakeExtractor({ disk: fileSystem.disk })

    const result = await restoreInstallationBackup(fakePorts({ fileSystem, extractor }), { installation: snapshot(), backup: archive }, recordingEvents())

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(trace, [
      `exists:${ARCHIVE_PATH}`,
      "guard-acquire:Restoring an installation backup.",
      "started",
      `extract:${ARCHIVE_PATH}->${STAGING_PATH}`,
      `move:${INSTALLATION_PATH}->${REPLACED_PATH}`,
      `move:${STAGING_PATH}->${INSTALLATION_PATH}`,
      `remove:${REPLACED_PATH}`,
      "guard-release",
      "finished"
    ])
    assert.equal(fileSystem.disk.has(INSTALLATION_PATH), true)
    assert.equal(fileSystem.disk.has(REPLACED_PATH), false)
    assert.equal(fileSystem.disk.has(STAGING_PATH), false)
  })

  it("never extracts into the live installation folder", async () => {
    const { extractor, requests } = fakeExtractor()

    await restoreInstallationBackup(fakePorts({ extractor }), { installation: snapshot(), backup: archive })

    assert.equal(requests[0]?.outputFolder, STAGING_PATH)
    assert.notEqual(requests[0]?.outputFolder, INSTALLATION_PATH)
  })

  it("reports a temporary folder it could not clean up without failing the restore", async () => {
    const fileSystem = fakeFileSystem({ failedRemovals: [REPLACED_PATH] })

    const result = await restoreInstallationBackup(fakePorts({ fileSystem }), { installation: snapshot(), backup: archive }, recordingEvents())

    assert.deepEqual(result, { ok: true })
    assert.equal(trace.includes(`left:${REPLACED_PATH}`), true)
  })
})

describe("restoreInstallationBackup failure tree", () => {
  it("leaves the installation untouched and cleans up when the extraction fails", async () => {
    const fileSystem = fakeFileSystem()
    const { extractor } = fakeExtractor({ outcome: { ok: false, error: "7z exploded" }, disk: fileSystem.disk })

    const result = await restoreInstallationBackup(fakePorts({ fileSystem, extractor }), { installation: snapshot(), backup: archive }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "extract-failed", strandedPath: null })
    assert.equal(fileSystem.disk.has(INSTALLATION_PATH), true)
    assert.equal(fileSystem.disk.has(STAGING_PATH), false)
    assert.equal(
      trace.some((entry) => entry.startsWith("move:")),
      false
    )
    assert.equal(trace.at(-2), "guard-release")
    assert.equal(trace.at(-1), "finished")
  })

  it("treats an extractor that never reports as a failed extraction", async () => {
    const { extractor } = fakeExtractor({ silent: true })

    const result = await restoreInstallationBackup(fakePorts({ extractor }), { installation: snapshot(), backup: archive })

    assert.equal(result.ok === false && result.reason, "extract-failed")
  })

  it("leaves the installation untouched when it cannot be set aside", async () => {
    const fileSystem = fakeFileSystem({ failedMoves: [INSTALLATION_PATH] })
    const { extractor } = fakeExtractor({ disk: fileSystem.disk })

    const result = await restoreInstallationBackup(fakePorts({ fileSystem, extractor }), { installation: snapshot(), backup: archive }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "set-aside-failed", strandedPath: null })
    assert.equal(fileSystem.disk.has(INSTALLATION_PATH), true)
    assert.equal(fileSystem.disk.has(STAGING_PATH), false)
  })

  it("rolls the original back when the extracted folder cannot take its place", async () => {
    const fileSystem = fakeFileSystem({ failedMoves: [STAGING_PATH] })
    const { extractor } = fakeExtractor({ disk: fileSystem.disk })

    const result = await restoreInstallationBackup(fakePorts({ fileSystem, extractor }), { installation: snapshot(), backup: archive }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "swap-failed", strandedPath: null })
    assert.equal(fileSystem.disk.has(INSTALLATION_PATH), true)
    assert.equal(fileSystem.disk.has(REPLACED_PATH), false)
    assert.equal(fileSystem.disk.has(STAGING_PATH), false)
    assert.deepEqual(trace, [
      `exists:${ARCHIVE_PATH}`,
      "guard-acquire:Restoring an installation backup.",
      "started",
      `extract:${ARCHIVE_PATH}->${STAGING_PATH}`,
      `move:${INSTALLATION_PATH}->${REPLACED_PATH}`,
      `move:${STAGING_PATH}->${INSTALLATION_PATH}`,
      `move:${REPLACED_PATH}->${INSTALLATION_PATH}`,
      `remove:${STAGING_PATH}`,
      "guard-release",
      "finished"
    ])
  })

  it("says where the data ended up when the rollback also fails", async () => {
    const fileSystem = fakeFileSystem({ failedMoves: [STAGING_PATH, REPLACED_PATH] })
    const { extractor } = fakeExtractor({ disk: fileSystem.disk })

    const result = await restoreInstallationBackup(fakePorts({ fileSystem, extractor }), { installation: snapshot(), backup: archive }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "swap-rollback-failed", strandedPath: REPLACED_PATH })
    assert.equal(fileSystem.disk.has(REPLACED_PATH), true)
    // The extracted folder is the only copy of the archive contents, so it stays.
    assert.equal(
      trace.some((entry) => entry === `remove:${STAGING_PATH}`),
      false
    )
  })

  it("keeps the primary reason when the cleanup itself throws", async () => {
    const fileSystem = fakeFileSystem({ failedMoves: [INSTALLATION_PATH], throwOnRemove: STAGING_PATH })
    const { extractor } = fakeExtractor({ disk: fileSystem.disk })

    const result = await restoreInstallationBackup(fakePorts({ fileSystem, extractor }), { installation: snapshot(), backup: archive }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "set-aside-failed", strandedPath: null })
    assert.equal(trace.includes(`left:${STAGING_PATH}`), true)
    assert.equal(trace.at(-1), "finished")
  })
})

/** A host lease that records when it was taken and given back, and can be told to refuse. */
function recordingLease(answer: InstallationLeaseOutcome | "grant" = "grant"): InstallationLease {
  return {
    acquire: async (installationId: string): Promise<InstallationLeaseOutcome> => {
      trace.push(`lease-acquire:${installationId}`)
      if (answer !== "grant") return answer
      return {
        ok: true,
        release: (): void => {
          trace.push("lease-release")
        }
      }
    }
  }
}

describe("restoreInstallationBackup host reservation", () => {
  it("holds the installation on the host for the whole swap and gives it back last", async () => {
    const ports = fakePorts({ installationLease: recordingLease() })

    const result = await restoreInstallationBackup(ports, { installation: snapshot(), backup: archive }, recordingEvents())

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("lease-") || entry.startsWith("move:") || entry === "finished"),
      ["lease-acquire:installation-1", `move:${INSTALLATION_PATH}->${REPLACED_PATH}`, `move:${STAGING_PATH}->${INSTALLATION_PATH}`, "lease-release", "finished"]
    )
  })

  it("gives the installation back when the extraction fails", async () => {
    const disk = new Set([INSTALLATION_PATH, ARCHIVE_PATH])
    const ports = fakePorts({ installationLease: recordingLease(), fileSystem: fakeFileSystem({ present: [...disk] }), extractor: fakeExtractor({ outcome: { ok: false, error: "bad" } }).extractor })

    const result = await restoreInstallationBackup(ports, { installation: snapshot(), backup: archive })

    assert.equal(result.ok === false && result.reason, "extract-failed")
    assert.equal(trace.at(-1), "lease-release")
  })

  it("gives the installation back when the extractor throws", async () => {
    const extractor: Extractor = {
      extract: async (): Promise<void> => {
        throw new Error("the worker died")
      }
    }
    const ports = fakePorts({ installationLease: recordingLease(), extractor })

    await assert.rejects(restoreInstallationBackup(ports, { installation: snapshot(), backup: archive }), /the worker died/)
    assert.equal(trace.at(-1), "lease-release")
  })

  it("refuses without extracting when a world operation holds the installation", async () => {
    const ports = fakePorts({ installationLease: recordingLease({ ok: false, reason: "busy" }) })

    const result = await restoreInstallationBackup(ports, { installation: snapshot(), backup: archive }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "installation-busy", strandedPath: null })
    assert.deepEqual(
      trace.filter((entry) => !entry.startsWith("exists:")),
      ["lease-acquire:installation-1"]
    )
  })

  it("refuses without extracting when the host says a game is running on it", async () => {
    const ports = fakePorts({ installationLease: recordingLease({ ok: false, reason: "playing" }) })

    const result = await restoreInstallationBackup(ports, { installation: snapshot(), backup: archive })

    assert.equal(result.ok === false && result.reason, "installation-playing")
    assert.equal(
      trace.some((entry) => entry.startsWith("extract:") || entry.startsWith("guard-")),
      false
    )
  })

  it("does not reserve the host for a restore the renderer already refused", async () => {
    const ports = fakePorts({ installationLease: recordingLease() })

    await restoreInstallationBackup(ports, { installation: snapshot({ isBackingUp: true }), backup: archive })
    await restoreInstallationBackup(ports, { installation: snapshot(), backup: { ...archive, path: "/missing.tar.gz" } })

    assert.equal(
      trace.some((entry) => entry.startsWith("lease-")),
      false
    )
  })
})
