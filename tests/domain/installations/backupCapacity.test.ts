import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { describeBackupSpaceShortfall, describeOversizedBackupSource, formatByteSize } from "@domain/installations/backupCapacity"
import { MAX_ARCHIVE_TOTAL_BYTES, MAX_BACKUP_TOTAL_BYTES } from "@src/ipc/validation"

/**
 * The two size decisions a backup makes, as plain arithmetic.
 *
 * The numbers in the "still refused" and "now accepted" rows are the ones from
 * issue #362: a 4 GB installation and a 19 GB one both used to be refused by a
 * ceiling meant for archives arriving over the network.
 */

const GIB = 1024 * 1024 * 1024

describe("formatByteSize", () => {
  it("names each unit at its own scale", () => {
    assert.equal(formatByteSize(512), "512 B")
    assert.equal(formatByteSize(4 * 1024), "4 KB")
    assert.equal(formatByteSize(700 * 1024 * 1024), "700 MB")
    assert.equal(formatByteSize(64 * GIB), "64 GB")
    assert.equal(formatByteSize(3 * 1024 * GIB), "3 TB")
  })

  it("keeps one decimal below ten, where it is the difference between 2.6 and 3", () => {
    assert.equal(formatByteSize(2.6 * GIB), "2.6 GB")
    assert.equal(formatByteSize(19.4 * GIB), "19 GB")
  })

  it("answers zero for nothing, a negative, and a number that is not one", () => {
    assert.equal(formatByteSize(0), "0 B")
    assert.equal(formatByteSize(-1), "0 B")
    assert.equal(formatByteSize(Number.NaN), "0 B")
  })

  it("stops at the largest unit it knows rather than running off the end", () => {
    assert.equal(formatByteSize(4096 * 1024 * GIB), "4096 TB")
  })
})

describe("describeOversizedBackupSource", () => {
  it("accepts the installations the old 2 GiB archive ceiling refused", () => {
    assert.equal(describeOversizedBackupSource(4 * GIB, MAX_BACKUP_TOTAL_BYTES), undefined)
    assert.equal(describeOversizedBackupSource(19 * GIB, MAX_BACKUP_TOTAL_BYTES), undefined)
    // The same sizes against the ceiling they used to be held to, so this row
    // fails if the two constants are ever collapsed back into one.
    assert.notEqual(describeOversizedBackupSource(4 * GIB, MAX_ARCHIVE_TOTAL_BYTES), undefined)
  })

  it("still refuses a source past the backup ceiling, and says by how much it missed", () => {
    const message = describeOversizedBackupSource(65 * GIB, MAX_BACKUP_TOTAL_BYTES)
    assert.equal(message, "Compression source is too large: 65 GB, over the 64 GB backup limit")
  })

  it("accepts a source exactly on the ceiling", () => {
    assert.equal(describeOversizedBackupSource(MAX_BACKUP_TOTAL_BYTES, MAX_BACKUP_TOTAL_BYTES), undefined)
  })

  it("keeps the fragment the renderer picks its sentence from", () => {
    // COMPRESS_FAILURE_NOTIFICATION in features/installations/adapters/backupFailure.ts.
    assert.match(String(describeOversizedBackupSource(65 * GIB, MAX_BACKUP_TOTAL_BYTES)), /is too large/)
  })
})

describe("describeBackupSpaceShortfall", () => {
  it("refuses when the destination has less room than the source is large", () => {
    assert.equal(describeBackupSpaceShortfall(10 * GIB, 6 * GIB), "Not enough free space for the backup: 4 GB more is needed")
  })

  it("accepts when there is exactly enough room, and when there is more", () => {
    assert.equal(describeBackupSpaceShortfall(10 * GIB, 10 * GIB), undefined)
    assert.equal(describeBackupSpaceShortfall(10 * GIB, 40 * GIB), undefined)
  })

  it("accepts when the filesystem could not answer, rather than treating silence as a full disk", () => {
    assert.equal(describeBackupSpaceShortfall(10 * GIB, undefined), undefined)
    assert.equal(describeBackupSpaceShortfall(10 * GIB, Number.NaN), undefined)
    assert.equal(describeBackupSpaceShortfall(10 * GIB, Number.POSITIVE_INFINITY), undefined)
    assert.equal(describeBackupSpaceShortfall(10 * GIB, -1), undefined)
  })

  it("refuses a genuinely full disk, which does answer, with zero", () => {
    assert.equal(describeBackupSpaceShortfall(GIB, 0), "Not enough free space for the backup: 1 GB more is needed")
  })
})
