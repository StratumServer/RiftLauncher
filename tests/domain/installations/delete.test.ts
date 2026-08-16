import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { deleteInstallation } from "../../../src/domain/installations/delete"
import type { DeleteInstallationEvents, DeleteInstallationPorts, InstallationDeleteSnapshot } from "../../../src/domain/installations/delete"

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

function fakePorts(options: { removals?: Record<string, boolean> } = {}): DeleteInstallationPorts {
  const removals = options.removals ?? {}
  return {
    fileSystem: {
      remove: async (path: string): Promise<boolean> => {
        trace.push(`remove:${path}`)
        return removals[path] ?? true
      }
    }
  }
}

function snapshot(overrides: Partial<InstallationDeleteSnapshot> = {}): InstallationDeleteSnapshot {
  return {
    path: "/installations/my-install",
    backups: [],
    isPlaying: false,
    isBackingUp: false,
    isRestoringBackup: false,
    ...overrides
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
    const result = await deleteInstallation(fakePorts(), { installation: snapshot({ backups: [{ path: "/backups/b1.zip" }] }), deleteData: false }, recordingEvents())

    assert.deepEqual(result, { ok: true, failedBackupPaths: [] })
    assert.deepEqual(trace, [])
  })
})

describe("deleteInstallation with data deletion", () => {
  it("removes the installation folder then every backup, reporting each", async () => {
    const installation = snapshot({ backups: [{ path: "/backups/b1.zip" }, { path: "/backups/b2.zip" }] })

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
    const installation = snapshot({ backups: [{ path: "/backups/b1.zip" }] })
    const ports = fakePorts({ removals: { "/installations/my-install": false } })

    const result = await deleteInstallation(ports, { installation, deleteData: true }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "data-delete-failed" })
    assert.deepEqual(trace, ["remove:/installations/my-install"])
  })

  it("keeps going past a failed backup deletion instead of aborting", async () => {
    const installation = snapshot({ backups: [{ path: "/backups/b1.zip" }, { path: "/backups/b2.zip" }, { path: "/backups/b3.zip" }] })
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
    const installation = snapshot({ backups: [{ path: "/backups/b1.zip" }, { path: "/backups/b2.zip" }] })
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
})
