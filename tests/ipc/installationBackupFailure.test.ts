import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"
import fse from "fs-extra"

import { makeInstallationBackup } from "@domain/installations/backup"
import type { BackupRecord, MakeInstallationBackupPorts } from "@domain/installations/backup"
import { runCompression } from "@src/ipc/workers/compression"

/**
 * Issue #704. The domain service runs on the real compression worker and the real disk, so what a
 * player's Backups folder holds after a refused backup is what is asserted, not a trace of calls.
 */
let root = ""
let installPath = ""
let backupsFolder = ""
let archiveFolder = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rift-backup-failure-"))
  installPath = join(root, "Installations", "Modded")
  backupsFolder = join(root, "Backups")
  archiveFolder = join(backupsFolder, "Installations", "Modded")
  mkdirSync(join(installPath, "Saves"), { recursive: true })
  writeFileSync(join(installPath, "Saves", "world.vcdbs"), "world")
  mkdirSync(archiveFolder, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function oldArchive(id: string): BackupRecord {
  const path = join(archiveFolder, `${id}.tar.gz`)
  writeFileSync(path, `archive ${id}`)
  return { id, date: 1, path }
}

function realPorts(now: () => number = () => Date.now()): MakeInstallationBackupPorts {
  let issued = 0
  return {
    fileSystem: { exists: (path) => fse.pathExists(path), remove: async (path) => (await fse.remove(path), true), move: async () => false },
    archiver: {
      compress: async (request, done) => {
        try {
          await runCompression({ inputPath: request.sourcePath, outputPath: request.outputFolder, outputFileName: request.fileName, compressionLevel: request.compressionLevel })
          done({ ok: true })
        } catch (error) {
          done({ ok: false, error: (error as Error).message })
        }
      }
    },
    clock: { now },
    ids: { newId: () => `new-id-${(issued += 1)}` },
    paths: { join: async (parts) => join(...parts) },
    closeGuard: { acquire: () => () => undefined },
    installationLease: { acquire: async () => ({ ok: true, release: async () => undefined }) }
  }
}

function input(backups: BackupRecord[], backupsLimit: number): Parameters<typeof makeInstallationBackup>[1] {
  return {
    installation: { id: "inst-1", name: "Modded", path: installPath, backupsLimit, compressionLevel: 6, backups, isBackingUp: false, isPlaying: false, isRestoringBackup: false },
    backupsFolder
  }
}

describe("an Installation backup the compression refuses", () => {
  it("leaves the only backup of a limit of 1 on disk, with the Mods folder linked from another disk", async () => {
    const otherDisk = join(root, "OtherDisk", "Mods")
    mkdirSync(otherDisk, { recursive: true })
    symlinkSync(otherDisk, join(installPath, "Mods"))
    const old = oldArchive("old")
    const deleted: string[] = []

    const result = await makeInstallationBackup(realPorts(), input([old], 1), { onBackupDeleted: (backup) => deleted.push(backup.id) })

    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, "compress-failed")
    assert.deepEqual(result.deletedBackupIds, [])
    assert.deepEqual(deleted, [])
    assert.equal(readFileSync(old.path, "utf8"), "archive old")
  })

  it("leaves every backup of a lowered limit on disk", async () => {
    symlinkSync(join(root, "elsewhere"), join(installPath, "Mods"))
    const records = ["b3", "b2", "b1"].map(oldArchive)

    const result = await makeInstallationBackup(realPorts(), input(records, 1))

    assert.equal(result.ok, false)
    assert.deepEqual(readdirSync(archiveFolder).sort(), ["b1.tar.gz", "b2.tar.gz", "b3.tar.gz"])
  })
})

describe("an Installation backup that works", () => {
  it("records the new archive first, then prunes down to the limit", async () => {
    const records = ["b2", "b1"].map(oldArchive)
    const events: string[] = []

    const result = await makeInstallationBackup(realPorts(), input(records, 2), {
      onBackupCreated: (backup) => events.push(`created:${backup.id}:${readdirSync(archiveFolder).length}`),
      onBackupDeleted: (backup) => events.push(`deleted:${backup.id}`)
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.deletedBackupIds, ["b1"])
    // The new archive was complete (three files) when it was handed over, before the oldest came off.
    assert.deepEqual(events, ["created:new-id-1:3", "deleted:b1"])
    assert.equal(readdirSync(archiveFolder).length, 2)
  })
})

/**
 * Archive names only have one-second resolution, so a second backup in the same second used to be
 * written over the first one's file, and the prune that followed then removed it.
 */
describe("two Installation backups in the same second", () => {
  const SAME_SECOND = new Date(2025, 9, 9, 10, 53, 20, 100).getTime()

  async function backUpTwice(limit: number): Promise<{ first: BackupRecord; second: BackupRecord; secondResult: Awaited<ReturnType<typeof makeInstallationBackup>> }> {
    const first = await makeInstallationBackup(
      realPorts(() => SAME_SECOND),
      input([], limit)
    )
    assert.equal(first.ok, true)
    if (!first.ok) throw new Error("first backup failed")

    const secondResult = await makeInstallationBackup(
      realPorts(() => SAME_SECOND + 400),
      input([first.backup], limit)
    )
    assert.equal(secondResult.ok, true)
    if (!secondResult.ok) throw new Error("second backup failed")
    return { first: first.backup, second: secondResult.backup, secondResult }
  }

  it("leaves the new archive on disk with a limit of 1", async () => {
    const { first, second, secondResult } = await backUpTwice(1)

    assert.equal(fse.pathExistsSync(second.path), true)
    assert.notEqual(second.path, first.path)
    assert.deepEqual(secondResult.deletedBackupIds, [first.id])
    assert.deepEqual(readdirSync(archiveFolder), [basename(second.path)])
  })

  it("keeps both archives, each with its own record, with a limit above 1", async () => {
    const { first, second } = await backUpTwice(3)

    assert.deepEqual(readdirSync(archiveFolder).length, 2)
    assert.notEqual(second.path, first.path)
    assert.deepEqual(readdirSync(archiveFolder).sort(), [basename(first.path), basename(second.path)].sort())
  })

  it("does not write over an archive that is on disk but no longer listed", async () => {
    const first = await makeInstallationBackup(
      realPorts(() => SAME_SECOND),
      input([], 3)
    )
    assert.equal(first.ok, true)
    if (!first.ok) return
    const before = readFileSync(first.backup.path)

    const second = await makeInstallationBackup(
      realPorts(() => SAME_SECOND + 400),
      input([], 3)
    )

    assert.equal(second.ok && second.backup.path !== first.backup.path, true)
    assert.deepEqual(readFileSync(first.backup.path), before)
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps the older archive when the second backup of the second fails while writing", async () => {
    const first = await makeInstallationBackup(
      realPorts(() => SAME_SECOND),
      input([], 3)
    )
    assert.equal(first.ok, true)
    if (!first.ok) return
    const before = readFileSync(first.backup.path)
    // Readable when the tree is checked, refused once the archive is open: another program holding a file.
    const locked = join(installPath, "Saves", "locked.vcdbs")
    writeFileSync(locked, "locked")
    chmodSync(locked, 0o000)

    const second = await makeInstallationBackup(
      realPorts(() => SAME_SECOND + 400),
      input([first.backup], 3)
    )

    assert.equal(second.ok, false)
    assert.deepEqual(readFileSync(first.backup.path), before)
  })
})
