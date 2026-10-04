import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { makeInstallationBackup } from "../../../src/domain/installations/backup"
import type { BackupRecord, InstallationSnapshot, MakeInstallationBackupEvents, MakeInstallationBackupPorts } from "../../../src/domain/installations/backup"
import type { Archiver, CompressOutcome, CompressRequest, FileSystem } from "../../../src/domain/ports"

// Local wall-clock 2025-08-16 01:20:00, whatever zone the runner is in: the archive name
// carries the host's own clock now (see formatTimestampForFilename), so the expected stamp
// below has to be built from local fields rather than from a fixed UTC instant.
const FIXED_NOW = new Date(2025, 7, 16, 1, 20, 0).getTime()

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

/**
 * `missing` holds paths that are no longer on disk, an archive or a whole folder:
 * the host refuses to delete a path it cannot find (assertManagedDeletionPath in
 * ipc/pathPolicy.ts runs with allowMissing false), so those answer false to both
 * calls. `refused` holds paths the host will not answer about at all, the way
 * assertManagedPath turns away one outside the folders the config names.
 */
function fakeFileSystem(options: { exists?: boolean; removals?: Record<string, boolean>; missing?: readonly string[]; refused?: readonly string[] } = {}): FileSystem {
  const removals = options.removals ?? {}
  const missing = new Set(options.missing ?? [])
  const refused = new Set(options.refused ?? [])
  return {
    exists: async (path: string): Promise<boolean> => {
      trace.push(`exists:${path}`)
      if (refused.has(path)) throw new TypeError("Unmanaged path")
      if (missing.has(path)) return false
      return options.exists ?? true
    },
    remove: async (path: string): Promise<boolean> => {
      trace.push(`remove:${path}`)
      if (missing.has(path)) return false
      return removals[path] ?? true
    },
    move: async (from: string, to: string): Promise<boolean> => {
      trace.push(`move:${from}->${to}`)
      return true
    }
  }
}

function fakeArchiver(options: { outcome?: CompressOutcome; silent?: boolean } = {}): { archiver: Archiver; requests: CompressRequest[] } {
  const requests: CompressRequest[] = []
  const archiver: Archiver = {
    compress: async (request: CompressRequest, onComplete: (outcome: CompressOutcome) => void): Promise<void> => {
      trace.push(`compress:${request.outputFolder}/${request.fileName}`)
      requests.push(request)
      if (!options.silent) onComplete(options.outcome ?? { ok: true })
    }
  }
  return { archiver, requests }
}

function fakePorts(overrides: Partial<MakeInstallationBackupPorts> = {}): MakeInstallationBackupPorts {
  let issued = 0
  return {
    fileSystem: fakeFileSystem(),
    archiver: fakeArchiver().archiver,
    clock: { now: (): number => FIXED_NOW },
    ids: {
      newId: (): string => {
        issued += 1
        return `generated-id-${issued}`
      }
    },
    paths: { join: async (parts: string[]): Promise<string> => parts.join("/") },
    closeGuard: {
      acquire: (reason: string) => {
        trace.push(`guard-acquire:${reason}`)
        return (): void => {
          trace.push("guard-release")
        }
      }
    },
    ...overrides
  }
}

function backup(id: string, overrides: { isDeleting?: boolean; isRestoring?: boolean; path?: string } = {}): BackupRecord & { isDeleting?: boolean; isRestoring?: boolean } {
  return { id, date: 1, path: `/backups/${id}.tar.gz`, ...overrides }
}

function snapshot(overrides: Partial<InstallationSnapshot> = {}): InstallationSnapshot {
  return {
    id: "installation-1",
    name: "My Install: Test",
    path: "/games/my-install",
    backupsLimit: 3,
    compressionLevel: 5,
    backups: [],
    isBackingUp: false,
    isPlaying: false,
    isRestoringBackup: false,
    ...overrides
  }
}

function recordingEvents(): MakeInstallationBackupEvents {
  return {
    onStarted: (): void => {
      trace.push("started")
    },
    onFinished: (): void => {
      trace.push("finished")
    },
    onBackupDeleted: (deleted): void => {
      trace.push(`deleted:${deleted.id}`)
    }
  }
}

beforeEach(() => {
  trace = []
})

describe("makeInstallationBackup preconditions", () => {
  it("refuses an installation that is already being backed up", async () => {
    const result = await makeInstallationBackup(fakePorts(), { installation: snapshot({ isBackingUp: true }), backupsFolder: "/backups" })

    assert.deepEqual(result, { ok: false, reason: "installation-busy", deletedBackupIds: [] })
    assert.deepEqual(trace, [])
  })

  it("refuses an installation that is running", async () => {
    const result = await makeInstallationBackup(fakePorts(), { installation: snapshot({ isPlaying: true }), backupsFolder: "/backups" })

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.reason, "installation-playing")
  })

  it("refuses an installation that is restoring a backup", async () => {
    const result = await makeInstallationBackup(fakePorts(), { installation: snapshot({ isRestoringBackup: true }), backupsFolder: "/backups" })

    assert.equal(result.ok === false && result.reason, "restore-in-progress")
  })

  it("names the missing installation folder instead of silently succeeding", async () => {
    const result = await makeInstallationBackup(fakePorts({ fileSystem: fakeFileSystem({ exists: false }) }), { installation: snapshot(), backupsFolder: "/backups" })

    assert.equal(result.ok === false && result.reason, "installation-path-missing")
    assert.deepEqual(trace, ["exists:/games/my-install"])
  })

  it("names the missing backups folder instead of silently succeeding", async () => {
    const result = await makeInstallationBackup(fakePorts(), { installation: snapshot(), backupsFolder: "" })

    assert.equal(result.ok === false && result.reason, "no-backups-folder")
  })

  it("names a zero backups limit instead of silently succeeding", async () => {
    const result = await makeInstallationBackup(fakePorts(), { installation: snapshot({ backupsLimit: 0 }), backupsFolder: "/backups" })

    assert.equal(result.ok === false && result.reason, "backups-disabled")
  })

  it("never touches the close guard when a precondition fails", async () => {
    await makeInstallationBackup(fakePorts(), { installation: snapshot({ backupsLimit: 0 }), backupsFolder: "/backups" }, recordingEvents())

    assert.equal(
      trace.some((entry) => entry.startsWith("guard-")),
      false
    )
    assert.equal(trace.includes("started"), false)
  })
})

describe("makeInstallationBackup pruning", () => {
  it("deletes from the end of the list while the limit is reached and reports every deletion", async () => {
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b1"), backup("b2"), backup("b3")] })

    const result = await makeInstallationBackup(fakePorts(), { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b3", "b2"])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      ["remove:/backups/b3.tar.gz", "deleted:b3", "remove:/backups/b2.tar.gz", "deleted:b2"]
    )
  })

  it("keeps every backup when the list is still under the limit", async () => {
    const installation = snapshot({ backupsLimit: 5, backups: [backup("b1"), backup("b2")] })

    const result = await makeInstallationBackup(fakePorts(), { installation, backupsFolder: "/backups" })

    assert.deepEqual(result.deletedBackupIds, [])
    assert.equal(
      trace.some((entry) => entry.startsWith("remove:")),
      false
    )
  })

  it("stops at the first failed deletion and reports the ones already done", async () => {
    const installation = snapshot({ backupsLimit: 1, backups: [backup("b1"), backup("b2"), backup("b3")] })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ removals: { "/backups/b2.tar.gz": false } }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    // b3 came off, b2 could not, so prune stops and names b2 as the one it left behind.
    assert.deepEqual(result, { ok: false, reason: "prune-failed", deletedBackupIds: ["b3"], detail: "b2" })
    assert.equal(
      trace.some((entry) => entry.startsWith("compress:")),
      false
    )
    assert.equal(trace.at(-2), "guard-release")
    assert.equal(trace.at(-1), "finished")
  })

  it("skips the oldest backup when it is already being deleted elsewhere, without touching its file", async () => {
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b1"), backup("b2"), backup("b3", { isDeleting: true })] })

    const result = await makeInstallationBackup(fakePorts(), { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b2"])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      ["remove:/backups/b2.tar.gz", "deleted:b2"]
    )
  })

  it("counts a skipped in-flight deletion toward the limit instead of also removing a newer backup", async () => {
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b1"), backup("b2", { isDeleting: true })] })

    const result = await makeInstallationBackup(fakePorts(), { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, [])
    assert.equal(
      trace.some((entry) => entry.startsWith("remove:")),
      false
    )
  })

  it("keeps pruning past a skipped in-flight deletion to reach the limit", async () => {
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b1"), backup("b2"), backup("b3", { isDeleting: true }), backup("b4")] })

    const result = await makeInstallationBackup(fakePorts(), { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b4", "b2"])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      ["remove:/backups/b4.tar.gz", "deleted:b4", "remove:/backups/b2.tar.gz", "deleted:b2"]
    )
  })

  it("makes the backup when the oldest record's archive is already gone from disk", async () => {
    // Reported on Discord: six records, the two oldest deleted from the Backups
    // folder by hand, so the player counted four archives. The prune could not
    // remove a file that was not there and the whole backup was refused.
    const installation = snapshot({ backupsLimit: 6, backups: [backup("b1"), backup("b2"), backup("b3"), backup("b4"), backup("b5"), backup("b6")] })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ missing: ["/backups/b5.tar.gz", "/backups/b6.tar.gz"] }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    // Four archives are on disk against a limit of six, so none has to go. Both
    // stale records come off: reporting a record as deleted is what drops it from
    // the installation, so it stops taking a slot.
    assert.deepEqual(result.deletedBackupIds, ["b5", "b6"])
    assert.equal(
      trace.some((entry) => entry.startsWith("compress:")),
      true
    )
  })

  it("keeps the only archive on disk when a record whose archive is gone holds the other slot", async () => {
    // #610: a limit of two, two backups made, then the newer archive deleted from the Backups
    // folder by hand. Counting records, the prune took the older one, the last archive left.
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b2"), backup("b1")] })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ missing: ["/backups/b2.tar.gz"] }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b2"])
    // The stale record comes off with no delete call, and b1 is never touched.
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      ["deleted:b2"]
    )
  })

  it("counts only the archives on disk against the limit, wherever the stale record sits", async () => {
    // Three archives are on disk (b1, b3, b4) against a limit of three, so room for the new one
    // takes exactly one removal, the oldest, whatever b2 did to the number of records.
    const installation = snapshot({ backupsLimit: 3, backups: [backup("b1"), backup("b2"), backup("b3"), backup("b4")] })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ missing: ["/backups/b2.tar.gz"] }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b2", "b4"])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      ["deleted:b2", "remove:/backups/b4.tar.gz", "deleted:b4"]
    )
  })

  it("drops every record, without a delete call, when all the archives were deleted by hand", async () => {
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b1"), backup("b2")] })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ missing: ["/backups/b1.tar.gz", "/backups/b2.tar.gz"] }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b1", "b2"])
    assert.equal(
      trace.some((entry) => entry.startsWith("remove:")),
      false
    )
    assert.equal(
      trace.some((entry) => entry.startsWith("compress:")),
      true
    )
  })

  it("keeps a live archive past a stale record and a deletion in flight", async () => {
    // b1 is gone from disk and b3 is on its way out through a manual delete, so b2 is the one
    // archive that stays and nothing makes it go.
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b1"), backup("b2"), backup("b3", { isDeleting: true })] })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ missing: ["/backups/b1.tar.gz"] }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b1"])
    assert.equal(
      trace.some((entry) => entry.startsWith("remove:")),
      false
    )
  })

  it("keeps a record whose folder is not there, uncounted, and deletes nothing because of it", async () => {
    // The Backups folder sits on a drive that is not connected. Nothing says its archive is gone,
    // and the archive that is on disk must not be deleted to make room for a record that holds no slot.
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b2", { path: "/drive/b2.tar.gz" }), backup("b1")] })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ missing: ["/drive", "/drive/b2.tar.gz"] }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, [])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      []
    )
    assert.equal(trace.includes("exists:/drive"), true)
  })

  it("leaves every record alone when the drive holding the archives is not connected", async () => {
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b1", { path: "/drive/b1.tar.gz" }), backup("b2", { path: "/drive/b2.tar.gz" })] })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ missing: ["/drive", "/drive/b1.tar.gz", "/drive/b2.tar.gz"] }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, [])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      []
    )
    assert.equal(
      trace.some((entry) => entry.startsWith("compress:")),
      true
    )
  })

  it("tells gone, unreachable and live records apart in one list", async () => {
    // b3 was deleted by hand from a folder that is still there. b2 and b6 sit on a drive that is not.
    // Only b3 comes off the list, and the three archives on disk (b1, b4, b5) are at the limit of three,
    // so the oldest of them goes.
    const installation = snapshot({
      backupsLimit: 3,
      backups: [backup("b1"), backup("b2", { path: "/drive/b2.tar.gz" }), backup("b3"), backup("b4"), backup("b5"), backup("b6", { path: "/drive/b6.tar.gz" })]
    })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ missing: ["/drive", "/drive/b2.tar.gz", "/drive/b6.tar.gz", "/backups/b3.tar.gz"] }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b3", "b5"])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      ["deleted:b3", "remove:/backups/b5.tar.gz", "deleted:b5"]
    )
    // A folder is only asked about when its archive is missing: b3, b2 and b6.
    assert.deepEqual(trace.filter((entry) => entry === "exists:/backups" || entry === "exists:/drive").sort(), ["exists:/backups", "exists:/drive", "exists:/drive"])
  })

  it("reads a path the host will not answer about as unreachable", async () => {
    // A Backups folder changed in Config leaves b3 in a folder the host no longer manages, and asking
    // about it is refused. The host refuses b2's own path too. Neither proves a deleted file, so both stay.
    const installation = snapshot({ backupsLimit: 3, backups: [backup("b3", { path: "/old-backups/b3.tar.gz" }), backup("b2"), backup("b1")] })
    const ports = fakePorts({ fileSystem: fakeFileSystem({ missing: ["/old-backups/b3.tar.gz"], refused: ["/old-backups", "/backups/b2.tar.gz"] }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, [])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      []
    )
  })

  it("skips the oldest backup when it is being restored, without touching its file", async () => {
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b1"), backup("b2"), backup("b3", { isRestoring: true })] })

    const result = await makeInstallationBackup(fakePorts(), { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b2"])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      ["remove:/backups/b2.tar.gz", "deleted:b2"]
    )
  })
})

describe("makeInstallationBackup archiving", () => {
  it("builds the archive name from a cleaned installation name and a local date stamp", async () => {
    const { archiver, requests } = fakeArchiver()

    const result = await makeInstallationBackup(fakePorts({ archiver }), { installation: snapshot(), backupsFolder: "/backups" })

    assert.equal(requests[0]?.fileName, "My-Install-Test_2025-08-16_01-20-00.tar.gz")
    assert.equal(requests[0]?.outputFolder, "/backups/Installations/My-Install-Test")
    assert.equal(requests[0]?.sourcePath, "/games/my-install")
    assert.equal(requests[0]?.compressionLevel, 5)
    assert.equal(result.ok === true && result.backup.path, "/backups/Installations/My-Install-Test/My-Install-Test_2025-08-16_01-20-00.tar.gz")
  })

  it("falls back to a slice of the installation id when the cleaned name is empty", async () => {
    const { archiver, requests } = fakeArchiver()

    const result = await makeInstallationBackup(fakePorts({ archiver }), { installation: snapshot({ id: "installation-1", name: "***" }), backupsFolder: "/backups" })

    assert.equal(requests[0]?.fileName, "installa_2025-08-16_01-20-00.tar.gz")
    assert.equal(requests[0]?.outputFolder, "/backups/Installations/installa")
    assert.equal(result.ok === true && result.backup.path, "/backups/Installations/installa/installa_2025-08-16_01-20-00.tar.gz")
  })

  it("stamps the record with the clock time and a generated id", async () => {
    const result = await makeInstallationBackup(fakePorts(), { installation: snapshot(), backupsFolder: "/backups" })

    assert.deepEqual(result.ok === true && result.backup, {
      id: "generated-id-1",
      date: FIXED_NOW,
      path: "/backups/Installations/My-Install-Test/My-Install-Test_2025-08-16_01-20-00.tar.gz"
    })
  })

  it("holds the close guard around the work and releases it on success", async () => {
    await makeInstallationBackup(fakePorts(), { installation: snapshot({ backupsLimit: 1, backups: [backup("b1")] }), backupsFolder: "/backups" }, recordingEvents())

    assert.deepEqual(trace, [
      "exists:/games/my-install",
      "guard-acquire:Making and installation backup.",
      "started",
      "exists:/backups/b1.tar.gz",
      "remove:/backups/b1.tar.gz",
      "deleted:b1",
      "compress:/backups/Installations/My-Install-Test/My-Install-Test_2025-08-16_01-20-00.tar.gz",
      "guard-release",
      "finished"
    ])
  })

  it("surfaces a failed compression without producing a record", async () => {
    const { archiver } = fakeArchiver({ outcome: { ok: false, error: "7z exploded" } })

    const result = await makeInstallationBackup(fakePorts({ archiver }), { installation: snapshot(), backupsFolder: "/backups" }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "compress-failed", deletedBackupIds: [], detail: "7z exploded" })
    assert.equal(trace.at(-2), "guard-release")
    assert.equal(trace.at(-1), "finished")
  })

  it("treats an archiver that never reports as a failure", async () => {
    const { archiver } = fakeArchiver({ silent: true })

    const result = await makeInstallationBackup(fakePorts({ archiver }), { installation: snapshot(), backupsFolder: "/backups" })

    assert.equal(result.ok === false && result.reason, "compress-failed")
  })
})
