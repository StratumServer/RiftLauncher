import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { deleteInstallationBackup } from "../../../src/domain/installations/backupDeletion"
import type { BackupSnapshot } from "../../../src/domain/installations/backup"

function backup(overrides: Partial<BackupSnapshot> = {}): BackupSnapshot {
  return { id: "backup-1", path: "/backups/my-install.zip", isRestoring: false, isDeleting: false, ...overrides }
}

function ports(options: { removed?: boolean } = {}): { fileSystem: { remove: (path: string) => Promise<boolean> }; removals: string[] } {
  const removals: string[] = []
  return {
    fileSystem: {
      remove: async (path: string): Promise<boolean> => {
        removals.push(path)
        return options.removed ?? true
      }
    },
    removals
  }
}

describe("deleteInstallationBackup", () => {
  it("removes the archive file and reports success", async () => {
    const hosts = ports()

    const result = await deleteInstallationBackup(hosts, { backup: backup() })

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(hosts.removals, ["/backups/my-install.zip"])
  })

  it("refuses an archive that is being restored", async () => {
    const hosts = ports()

    const result = await deleteInstallationBackup(hosts, { backup: backup({ isRestoring: true }) })

    assert.deepEqual(result, { ok: false, reason: "backup-in-use" })
    assert.deepEqual(hosts.removals, [])
  })

  it("refuses an archive that is already being deleted", async () => {
    const result = await deleteInstallationBackup(ports(), { backup: backup({ isDeleting: true }) })

    assert.deepEqual(result, { ok: false, reason: "backup-in-use" })
  })

  it("reports a failed file deletion so the record is kept", async () => {
    const result = await deleteInstallationBackup(ports({ removed: false }), { backup: backup() })

    assert.deepEqual(result, { ok: false, reason: "file-delete-failed" })
  })
})
