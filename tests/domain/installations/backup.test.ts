import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { makeInstallationBackup } from "../../../src/domain/installations/backup"
import type { BackupRecord, InstallationSnapshot, MakeInstallationBackupEvents, MakeInstallationBackupPorts } from "../../../src/domain/installations/backup"
import type { Archiver, CompressOutcome, CompressRequest, FileSystem } from "../../../src/domain/ports"

const FIXED_NOW = 1755300000000

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

function fakeFileSystem(options: { exists?: boolean; removals?: Record<string, boolean> } = {}): FileSystem {
  const removals = options.removals ?? {}
  return {
    exists: async (path: string): Promise<boolean> => {
      trace.push(`exists:${path}`)
      return options.exists ?? true
    },
    remove: async (path: string): Promise<boolean> => {
      trace.push(`remove:${path}`)
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

function backup(id: string, overrides: { isDeleting?: boolean; isRestoring?: boolean } = {}): BackupRecord & { isDeleting?: boolean; isRestoring?: boolean } {
  return { id, date: 1, path: `/backups/${id}.zip`, ...overrides }
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
      ["remove:/backups/b3.zip", "deleted:b3", "remove:/backups/b2.zip", "deleted:b2"]
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
    const ports = fakePorts({ fileSystem: fakeFileSystem({ removals: { "/backups/b2.zip": false } }) })

    const result = await makeInstallationBackup(ports, { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "prune-failed", deletedBackupIds: ["b3"] })
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
      ["remove:/backups/b2.zip", "deleted:b2"]
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
      ["remove:/backups/b4.zip", "deleted:b4", "remove:/backups/b2.zip", "deleted:b2"]
    )
  })

  it("skips the oldest backup when it is being restored, without touching its file", async () => {
    const installation = snapshot({ backupsLimit: 2, backups: [backup("b1"), backup("b2"), backup("b3", { isRestoring: true })] })

    const result = await makeInstallationBackup(fakePorts(), { installation, backupsFolder: "/backups" }, recordingEvents())

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b2"])
    assert.deepEqual(
      trace.filter((entry) => entry.startsWith("remove:") || entry.startsWith("deleted:")),
      ["remove:/backups/b2.zip", "deleted:b2"]
    )
  })
})

describe("makeInstallationBackup archiving", () => {
  it("builds the archive name from a cleaned installation name and a UTC date stamp", async () => {
    const { archiver, requests } = fakeArchiver()

    const result = await makeInstallationBackup(fakePorts({ archiver }), { installation: snapshot(), backupsFolder: "/backups" })

    assert.equal(requests[0]?.fileName, "My-Install-Test_2025-08-15_23-20-00.zip")
    assert.equal(requests[0]?.outputFolder, "/backups/Installations/My-Install-Test")
    assert.equal(requests[0]?.sourcePath, "/games/my-install")
    assert.equal(requests[0]?.compressionLevel, 5)
    assert.equal(result.ok === true && result.backup.path, "/backups/Installations/My-Install-Test/My-Install-Test_2025-08-15_23-20-00.zip")
  })

  it("falls back to a slice of the installation id when the cleaned name is empty", async () => {
    const { archiver, requests } = fakeArchiver()

    const result = await makeInstallationBackup(fakePorts({ archiver }), { installation: snapshot({ id: "installation-1", name: "***" }), backupsFolder: "/backups" })

    assert.equal(requests[0]?.fileName, "installa_2025-08-15_23-20-00.zip")
    assert.equal(requests[0]?.outputFolder, "/backups/Installations/installa")
    assert.equal(result.ok === true && result.backup.path, "/backups/Installations/installa/installa_2025-08-15_23-20-00.zip")
  })

  it("stamps the record with the clock time and a generated id", async () => {
    const result = await makeInstallationBackup(fakePorts(), { installation: snapshot(), backupsFolder: "/backups" })

    assert.deepEqual(result.ok === true && result.backup, {
      id: "generated-id-1",
      date: FIXED_NOW,
      path: "/backups/Installations/My-Install-Test/My-Install-Test_2025-08-15_23-20-00.zip"
    })
  })

  it("holds the close guard around the work and releases it on success", async () => {
    await makeInstallationBackup(fakePorts(), { installation: snapshot({ backupsLimit: 1, backups: [backup("b1")] }), backupsFolder: "/backups" }, recordingEvents())

    assert.deepEqual(trace, [
      "exists:/games/my-install",
      "guard-acquire:Making and installation backup.",
      "started",
      "remove:/backups/b1.zip",
      "deleted:b1",
      "compress:/backups/Installations/My-Install-Test/My-Install-Test_2025-08-15_23-20-00.zip",
      "guard-release",
      "finished"
    ])
  })

  it("surfaces a failed compression without producing a record", async () => {
    const { archiver } = fakeArchiver({ outcome: { ok: false, error: "7z exploded" } })

    const result = await makeInstallationBackup(fakePorts({ archiver }), { installation: snapshot(), backupsFolder: "/backups" }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "compress-failed", deletedBackupIds: [] })
    assert.equal(trace.at(-2), "guard-release")
    assert.equal(trace.at(-1), "finished")
  })

  it("treats an archiver that never reports as a failure", async () => {
    const { archiver } = fakeArchiver({ silent: true })

    const result = await makeInstallationBackup(fakePorts({ archiver }), { installation: snapshot(), backupsFolder: "/backups" })

    assert.equal(result.ok === false && result.reason, "compress-failed")
  })
})
