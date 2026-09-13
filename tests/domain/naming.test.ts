import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { buildGameVersionLabel, cleanFolderName, formatTimestampForFilename } from "../../src/domain/naming"

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
  it("formats an epoch timestamp as a sortable stamp", () => {
    assert.equal(formatTimestampForFilename(new Date(2025, 7, 16, 1, 20, 0).getTime()), "2025-08-16_01-20-00")
  })

  it("pads single-digit month, day, hour, minute and second fields", () => {
    assert.equal(formatTimestampForFilename(new Date(2026, 0, 2, 3, 4, 5).getTime()), "2026-01-02_03-04-05")
  })

  /**
   * #411 reported "Sweep-Install-2_2026-09-08_20-18-08.tar.gz" sitting next to a list row
   * reading 22:18:08 for that same archive. The stamp is the only thing in a backup's name a
   * player can match against the list, so it has to be the same clock the list reads.
   */
  it("reads the same clock the backups list shows", () => {
    const at = new Date(2026, 8, 8, 22, 18, 8).getTime()

    assert.equal(formatTimestampForFilename(at), "2026-09-08_22-18-08")
    // ManageInstallationBackups renders exactly this for the row next to the file.
    assert.ok(new Date(at).toLocaleString("es").includes("22:18:08"), "the list row and the file name disagree")
  })
})

describe("buildGameVersionLabel", () => {
  it("names a plain build by its version number alone", () => {
    assert.equal(buildGameVersionLabel("1.22.7"), "1.22.7")
  })

  it("spells the fork out after the game version it was built against", () => {
    assert.equal(buildGameVersionLabel("1.22.7", { name: "Optimum", version: "0.3.14" }), "1.22.7 Optimum 0.3.14")
  })
})
