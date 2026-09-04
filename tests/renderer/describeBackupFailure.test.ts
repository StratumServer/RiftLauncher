import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { describeBackupFailure } from "../../src/renderer/src/features/installations/adapters/backupFailure"

/**
 * Pins the part of #337 a human sees: the notification key a compress failure
 * resolves to, and the error-log line that carries the concrete cause. Both
 * were plumbed through the domain in the first pass but nothing on the renderer
 * side held them, so flattening either back to a constant went unnoticed.
 */
describe("describeBackupFailure notification key", () => {
  it("maps each compress failure kind to its own sentence", () => {
    assert.equal(describeBackupFailure("compress-failed", "Error compressing [PATH]: Error: Compression source is too large").messageKey, "features.backups.compressSourceTooLarge")
    assert.equal(describeBackupFailure("compress-failed", "Error compressing [PATH]: Error: Compression source contains an unsafe filesystem entry").messageKey, "features.backups.compressUnsafeEntry")
    // A shortfall is its own sentence, not "the archive could not be written":
    // the player can act on "the drive is full" and cannot act on the other.
    assert.equal(
      describeBackupFailure("compress-failed", "Error compressing [PATH]: Error: Not enough free space for the backup: 12 GB more is needed").messageKey,
      "features.backups.compressNoFreeSpace"
    )
    assert.equal(describeBackupFailure("compress-failed", "Error compressing [PATH]: Error: Too many filesystem entries").messageKey, "features.backups.compressTooManyFiles")
  })

  it("falls back to the write-failure sentence for a raw tar failure or an unrecognised cause", () => {
    assert.equal(describeBackupFailure("compress-failed", "Error compressing [PATH]: Error: Compression failed: ENOSPC: no space left on device").messageKey, "features.backups.compressWriteFailed")
    assert.equal(describeBackupFailure("compress-failed", "Error compressing [PATH]: Error: Compression destination is unsafe").messageKey, "features.backups.compressWriteFailed")
    assert.equal(describeBackupFailure("compress-failed", undefined).messageKey, "features.backups.compressWriteFailed")
  })

  it("gives prune failures their own sentence", () => {
    assert.equal(describeBackupFailure("prune-failed", "b2").messageKey, "features.backups.pruneFailed")
  })

  it("keeps the existing keys for the reasons with no cause to carry", () => {
    assert.equal(describeBackupFailure("installation-busy").messageKey, "features.backups.backupInProgress")
    assert.equal(describeBackupFailure("installation-playing").messageKey, "features.backups.backupWhilePlaying")
    assert.equal(describeBackupFailure("restore-in-progress").messageKey, "features.backups.restoreInProgress")
    assert.equal(describeBackupFailure("installation-path-missing").messageKey, "features.backups.installationPathMissing")
    assert.equal(describeBackupFailure("no-backups-folder").messageKey, "features.backups.noBackupsFolder")
    assert.equal(describeBackupFailure("backups-disabled").messageKey, "features.backups.backupsDisabled")
  })
})

describe("describeBackupFailure error-log line", () => {
  it("carries the compress cause into the log line", () => {
    const { logLine } = describeBackupFailure("compress-failed", "Error compressing [PATH]: Error: Compression source is too large")
    assert.ok(logLine?.includes("compress-failed"))
    assert.ok(logLine?.includes("Compression source is too large"), `expected the cause in the log line, got: ${logLine}`)
  })

  it("names the archive it could not remove for a prune failure", () => {
    assert.equal(describeBackupFailure("prune-failed", "b2").logLine, "Error creating backup: prune-failed. Could not remove backup b2")
  })

  it("logs the reason with no cause when there is none", () => {
    assert.equal(describeBackupFailure("compress-failed", undefined).logLine, "Error creating backup: compress-failed")
    assert.equal(describeBackupFailure("no-backups-folder").logLine, "Error creating backup: no-backups-folder")
  })

  it("stays silent for the expected refusals", () => {
    assert.equal(describeBackupFailure("installation-busy").logLine, null)
    assert.equal(describeBackupFailure("installation-playing").logLine, null)
    assert.equal(describeBackupFailure("restore-in-progress").logLine, null)
  })
})
