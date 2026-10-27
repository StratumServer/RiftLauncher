import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { deleteInstallation } from "../../../src/domain/installations/delete"
import type { DeleteInstallationEvents, DeleteInstallationPorts, InstallationDeleteSnapshot } from "../../../src/domain/installations/delete"
import type { InstallationLease, InstallationLeaseOutcome } from "../../../src/domain/ports"

type BackupFixture = InstallationDeleteSnapshot["backups"][number]

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

/** A lease that always grants and says nothing; the tests that care about it pass their own. */
const grantedLease: InstallationLease = { acquire: async (): Promise<InstallationLeaseOutcome> => ({ ok: true, release: (): void => {} }) }

function fakePorts(options: { removals?: Record<string, boolean>; missing?: readonly string[]; installationLease?: InstallationLease } = {}): DeleteInstallationPorts {
  const removals = options.removals ?? {}
  const missing = new Set(options.missing ?? [])
  return {
    fileSystem: {
      exists: async (path: string): Promise<boolean> => !missing.has(path),
      remove: async (path: string): Promise<boolean> => {
        trace.push(`remove:${path}`)
        if (missing.has(path)) return false
        return removals[path] ?? true
      }
    },
    installationLease: options.installationLease ?? grantedLease
  }
}

function backup(id: string, overrides: { isDeleting?: boolean; isRestoring?: boolean } = {}): BackupFixture {
  return { id, path: `/backups/${id}.zip`, ...overrides }
}

function snapshot(overrides: Partial<InstallationDeleteSnapshot> = {}): InstallationDeleteSnapshot {
  return {
    id: "my-install",
    path: "/installations/my-install",
    backups: [],
    isPlaying: false,
    isBackingUp: false,
    isRestoringBackup: false,
    ...overrides
  }
}

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

function recordingEvents(): DeleteInstallationEvents {
  return {
    onDataDeleted: (): void => {
      trace.push("data-deleted")
    },
    onBackupDeleted: (path): void => {
      trace.push(`backup-deleted:${path}`)
    },
    onBackupDeleteFailed: (path): void => {
      trace.push(`backup-delete-failed:${path}`)
    }
  }
}

beforeEach(() => {
  trace = []
})

describe("deleteInstallation preconditions", () => {
  it("refuses an installation that is being played", async () => {
    const result = await deleteInstallation(fakePorts(), { installation: snapshot({ isPlaying: true }), deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "installation-playing" })
    assert.deepEqual(trace, [])
  })

  it("refuses an installation that is being backed up", async () => {
    const result = await deleteInstallation(fakePorts(), { installation: snapshot({ isBackingUp: true }), deleteData: true })

    assert.equal(result.ok === false && result.reason, "installation-busy")
  })

  it("refuses an installation that is restoring a backup", async () => {
    const result = await deleteInstallation(fakePorts(), { installation: snapshot({ isRestoringBackup: true }), deleteData: true })

    assert.equal(result.ok === false && result.reason, "restore-in-progress")
  })

  it("checks isPlaying before isBackingUp before isRestoringBackup", async () => {
    const result = await deleteInstallation(fakePorts(), { installation: snapshot({ isPlaying: true, isBackingUp: true, isRestoringBackup: true }), deleteData: true })

    assert.equal(result.ok === false && result.reason, "installation-playing")
  })
})

describe("deleteInstallation without data deletion", () => {
  it("touches nothing on disk and reports success", async () => {
    const result = await deleteInstallation(fakePorts(), { installation: snapshot({ backups: [backup("b1")] }), deleteData: false }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
    assert.deepEqual(trace, [])
  })
})

describe("deleteInstallation with data deletion", () => {
  it("removes the installation folder then every backup, reporting each", async () => {
    const installation = snapshot({ backups: [backup("b1"), backup("b2")] })

    const result = await deleteInstallation(fakePorts(), { installation, deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
    assert.deepEqual(trace, [
      "remove:/installations/my-install",
      "data-deleted",
      "remove:/backups/b1.zip",
      "backup-deleted:/backups/b1.zip",
      "remove:/backups/b2.zip",
      "backup-deleted:/backups/b2.zip"
    ])
  })

  it("stops before touching any backup when the installation folder itself fails to delete", async () => {
    const installation = snapshot({ backups: [backup("b1")] })
    const ports = fakePorts({ removals: { "/installations/my-install": false } })

    const result = await deleteInstallation(ports, { installation, deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "data-delete-failed" })
    assert.deepEqual(trace, ["remove:/installations/my-install"])
  })

  it("keeps going past a failed backup deletion instead of aborting", async () => {
    const installation = snapshot({ backups: [backup("b1"), backup("b2"), backup("b3")] })
    const ports = fakePorts({ removals: { "/backups/b2.zip": false } })

    const result = await deleteInstallation(ports, { installation, deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: ["/backups/b2.zip"] })
    assert.deepEqual(trace, [
      "remove:/installations/my-install",
      "data-deleted",
      "remove:/backups/b1.zip",
      "backup-deleted:/backups/b1.zip",
      "remove:/backups/b2.zip",
      "backup-delete-failed:/backups/b2.zip",
      "remove:/backups/b3.zip",
      "backup-deleted:/backups/b3.zip"
    ])
  })

  it("collects every failed backup path, not just the first", async () => {
    const installation = snapshot({ backups: [backup("b1"), backup("b2")] })
    const ports = fakePorts({ removals: { "/backups/b1.zip": false, "/backups/b2.zip": false } })

    const result = await deleteInstallation(ports, { installation, deleteData: true })

    assert.deepEqual(result, { ok: true, failedBackupPaths: ["/backups/b1.zip", "/backups/b2.zip"] })
  })

  it("reports success without touching backups when there are none", async () => {
    const result = await deleteInstallation(fakePorts(), { installation: snapshot({ backups: [] }), deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
    assert.deepEqual(trace, ["remove:/installations/my-install", "data-deleted"])
  })

  it("works without events", async () => {
    const result = await deleteInstallation(fakePorts(), { installation: snapshot(), deleteData: true })

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
  })

  it("skips a backup already being deleted elsewhere, without touching its file or reporting it as failed", async () => {
    const installation = snapshot({
      backups: [backup("b1"), backup("b2", { isDeleting: true }), backup("b3")]
    })

    const result = await deleteInstallation(fakePorts(), { installation, deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
    assert.deepEqual(trace, [
      "remove:/installations/my-install",
      "data-deleted",
      "remove:/backups/b1.zip",
      "backup-deleted:/backups/b1.zip",
      "remove:/backups/b3.zip",
      "backup-deleted:/backups/b3.zip"
    ])
  })

  it("skips a backup being restored elsewhere, without touching its file or reporting it as failed", async () => {
    const installation = snapshot({
      backups: [backup("b1"), backup("b2", { isRestoring: true }), backup("b3")]
    })

    const result = await deleteInstallation(fakePorts(), { installation, deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
    assert.deepEqual(trace, [
      "remove:/installations/my-install",
      "data-deleted",
      "remove:/backups/b1.zip",
      "backup-deleted:/backups/b1.zip",
      "remove:/backups/b3.zip",
      "backup-deleted:/backups/b3.zip"
    ])
  })

  it("treats every backup as in flight the same way, reporting a clean success with none removed here", async () => {
    const installation = snapshot({
      backups: [backup("b1", { isDeleting: true }), backup("b2", { isDeleting: true })]
    })

    const result = await deleteInstallation(fakePorts(), { installation, deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
    assert.deepEqual(trace, ["remove:/installations/my-install", "data-deleted"])
  })
})

describe("deleteInstallation host reservation", () => {
  it("holds the installation on the host from before removing its folder until after backup cleanup", async () => {
    const installation = snapshot({ backups: [backup("b1")] })
    const result = await deleteInstallation(fakePorts({ installationLease: recordingLease() }), { installation, deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
    assert.deepEqual(trace, ["lease-acquire:my-install", "remove:/installations/my-install", "data-deleted", "remove:/backups/b1.zip", "backup-deleted:/backups/b1.zip", "lease-release"])
  })

  it("gives the installation back when the folder removal fails", async () => {
    const installation = snapshot({ backups: [backup("b1")] })
    const ports = fakePorts({ removals: { "/installations/my-install": false }, installationLease: recordingLease() })

    const result = await deleteInstallation(ports, { installation, deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "data-delete-failed" })
    assert.deepEqual(trace, ["lease-acquire:my-install", "remove:/installations/my-install", "lease-release"])
  })

  it("gives the installation back when the filesystem remove throws an exception", async () => {
    const ports: DeleteInstallationPorts = {
      fileSystem: {
        exists: async () => true,
        remove: async () => {
          trace.push("remove-throw")
          throw new Error("disk exploded")
        }
      },
      installationLease: recordingLease()
    }

    await assert.rejects(async () => deleteInstallation(ports, { installation: snapshot(), deleteData: true }), /disk exploded/)
    assert.equal(trace.at(-1), "lease-release")
  })

  it("refuses before touching the folder when a world operation holds the installation", async () => {
    const result = await deleteInstallation(fakePorts({ installationLease: recordingLease({ ok: false, reason: "busy" }) }), { installation: snapshot(), deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "installation-busy" })
    assert.deepEqual(trace, ["lease-acquire:my-install"])
  })

  it("refuses when the host says a game is running on the installation", async () => {
    const result = await deleteInstallation(fakePorts({ installationLease: recordingLease({ ok: false, reason: "playing" }) }), { installation: snapshot(), deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "installation-playing" })
    assert.deepEqual(trace, ["lease-acquire:my-install"])
  })

  it("does not acquire the lease when deleteData is false", async () => {
    const result = await deleteInstallation(fakePorts({ installationLease: recordingLease() }), { installation: snapshot({ backups: [backup("b1")] }), deleteData: false }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
    assert.deepEqual(trace, [])
  })
})
