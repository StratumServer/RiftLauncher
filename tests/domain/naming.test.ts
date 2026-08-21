import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { cleanFolderName, formatTimestampForFilename } from "../../src/domain/naming"

describe("cleanFolderName", () => {
  it("replaces characters a folder name cannot carry", () => {
    assert.equal(cleanFolderName('a<b>c:d"e/f\\g|h?i*j'), "a-b-c-d-e-f-g-h-i-j")
  })

  it("turns whitespace runs into a single dash", () => {
    assert.equal(cleanFolderName("My  great \t installation"), "My-great-installation")
  })

  it("collapses repeated dashes and trims the edges", () => {
    assert.equal(cleanFolderName("--My--Install--"), "My-Install")
  })

  it("leaves dots alone", () => {
    assert.equal(cleanFolderName("1.755.300.000.000"), "1.755.300.000.000")
  })

  it("can return an empty string", () => {
    assert.equal(cleanFolderName("   "), "")
  })

  it("empties a name made only of characters it has to replace", () => {
    assert.equal(cleanFolderName("***"), "")
  })

  it("empties the dot segments the path layer refuses", () => {
    // assertSafeFileName rejects "." and ".."; "..." would go through as a
    // real folder, which is no better a name to hand someone.
    assert.equal(cleanFolderName("."), "")
    assert.equal(cleanFolderName(".."), "")
    assert.equal(cleanFolderName("..."), "")
  })

  it("cuts a name down to the 255 characters a file name may hold", () => {
    assert.equal(cleanFolderName("a".repeat(300)), "a".repeat(255))
  })

  it("does not leave the dash the cut lands on", () => {
    assert.equal(cleanFolderName(`${"a".repeat(254)} bcd`), "a".repeat(254))
  })
})

describe("formatTimestampForFilename", () => {
  it("formats an epoch timestamp as a sortable UTC stamp", () => {
    assert.equal(formatTimestampForFilename(1755300000000), "2025-08-15_23-20-00")
  })

  it("pads single-digit month, day, hour, minute and second fields", () => {
    // 2026-01-02T03:04:05Z
    assert.equal(formatTimestampForFilename(Date.UTC(2026, 0, 2, 3, 4, 5)), "2026-01-02_03-04-05")
  })

  it("uses UTC regardless of the host's local time zone", () => {
    // 2026-01-01T00:30:00Z stays on the same UTC day even for a locale
    // that would otherwise roll it back to Dec 31 in a negative offset.
    assert.equal(formatTimestampForFilename(Date.UTC(2026, 0, 1, 0, 30, 0)), "2026-01-01_00-30-00")
  })
})
