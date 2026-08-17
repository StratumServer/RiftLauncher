import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import { describeUserDataSetup, LEGACY_USER_DATA_FOLDER, MIGRATION_TEMP_FOLDER, RIFT_USER_DATA_FOLDER, setUpUserDataFolder } from "@src/main/userDataMigration"

/**
 * The user-data folder setup, against a real appData directory in a temp folder.
 *
 * Nothing is mocked here on purpose. The whole point of the adapter is what it
 * does to files: which ones it copies, which ones it leaves where they are, and
 * what an interrupted copy leaves behind. A fake file system would only prove
 * the calls were made in the right order.
 */

let appDataPath = ""

function riftPath(): string {
  return join(appDataPath, RIFT_USER_DATA_FOLDER)
}

function legacyPath(): string {
  return join(appDataPath, LEGACY_USER_DATA_FOLDER)
}

function temporaryPath(): string {
  return join(appDataPath, MIGRATION_TEMP_FOLDER)
}

/** A VS Launcher folder as a player who has used the launcher would have it. */
function seedLegacyFolder(): void {
  mkdirSync(join(legacyPath(), "Icons"), { recursive: true })
  mkdirSync(join(legacyPath(), "Logs"), { recursive: true })
  mkdirSync(join(legacyPath(), "Cache", "ModCatalog"), { recursive: true })

  writeFileSync(join(legacyPath(), "config.json"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" }), "utf8")
  writeFileSync(join(legacyPath(), "account-secrets.json"), "sealed:placeholder", "utf8")
  writeFileSync(join(legacyPath(), "Icons", "custom.png"), "not really a png", "utf8")
  writeFileSync(join(legacyPath(), "Logs", "info.log"), "an old line", "utf8")
  writeFileSync(join(legacyPath(), "Cache", "ModCatalog", "catalog.json"), "[]", "utf8")
}

beforeEach(() => {
  appDataPath = mkdtempSync(join(tmpdir(), "riftlauncher-appdata-"))
})

afterEach(() => {
  if (existsSync(join(legacyPath(), "Icons"))) chmodSync(join(legacyPath(), "Icons"), 0o700)
  rmSync(appDataPath, { recursive: true, force: true })
})

describe("setUpUserDataFolder", () => {
  it("creates its own folder on a machine that has never seen either launcher", () => {
    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.path, riftPath())
    assert.equal(setup.outcome, "fresh")
    assert.deepEqual(setup.copied, [])
    assert.equal(setup.cleanedStaleMigration, false)
    assert.equal(existsSync(riftPath()), true)
    assert.deepEqual(readdirSync(riftPath()), [])
  })

  it("copies the config and the icons out of a VS Launcher folder, and leaves the rest behind", () => {
    seedLegacyFolder()

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.path, riftPath())
    assert.equal(setup.outcome, "migrate")
    assert.deepEqual(setup.copied, ["config.json", "Icons"])
    assert.deepEqual(readdirSync(riftPath()).sort(), ["Icons", "config.json"])
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" }))
    assert.equal(readFileSync(join(riftPath(), "Icons", "custom.png"), "utf8"), "not really a png")
    assert.equal(existsSync(join(riftPath(), "Logs")), false)
    assert.equal(existsSync(join(riftPath(), "Cache")), false)
    assert.equal(existsSync(join(riftPath(), "account-secrets.json")), false)
    assert.equal(existsSync(temporaryPath()), false)
  })

  it("leaves the VS Launcher folder exactly as it found it", () => {
    seedLegacyFolder()

    setUpUserDataFolder(appDataPath)

    assert.deepEqual(readdirSync(legacyPath()).sort(), ["Cache", "Icons", "Logs", "account-secrets.json", "config.json"])
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" }))
    assert.equal(readFileSync(join(legacyPath(), "Icons", "custom.png"), "utf8"), "not really a png")
    assert.equal(readFileSync(join(legacyPath(), "Logs", "info.log"), "utf8"), "an old line")
  })

  it("copies whatever of the two entries is actually there", () => {
    mkdirSync(legacyPath(), { recursive: true })
    writeFileSync(join(legacyPath(), "config.json"), "{}", "utf8")

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migrate")
    assert.deepEqual(setup.copied, ["config.json"])
    assert.deepEqual(readdirSync(riftPath()), ["config.json"])
  })

  it("does not touch a RiftLauncher folder that is already there, even next to a VS Launcher one", () => {
    seedLegacyFolder()
    mkdirSync(riftPath(), { recursive: true })
    writeFileSync(join(riftPath(), "config.json"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "mine" }), "utf8")

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "use-existing")
    assert.deepEqual(setup.copied, [])
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "mine" }))
    assert.deepEqual(readdirSync(riftPath()), ["config.json"])
  })

  it("throws away a temporary folder left by an earlier run instead of promoting it", () => {
    seedLegacyFolder()
    mkdirSync(temporaryPath(), { recursive: true })
    writeFileSync(join(temporaryPath(), "config.json"), JSON.stringify({ half: "written" }), "utf8")

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migrate")
    assert.equal(setup.cleanedStaleMigration, true)
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" }))
    assert.equal(existsSync(temporaryPath()), false)
  })

  it("cleans a leftover temporary folder up even when there is nothing to migrate", () => {
    mkdirSync(riftPath(), { recursive: true })
    mkdirSync(temporaryPath(), { recursive: true })

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "use-existing")
    assert.equal(setup.cleanedStaleMigration, true)
    assert.equal(existsSync(temporaryPath()), false)
  })

  it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("starts on an empty folder when the copy cannot be read, rather than failing to start", () => {
    seedLegacyFolder()
    // Unreadable icons folder: the copy gets through config.json and dies halfway.
    chmodSync(join(legacyPath(), "Icons"), 0o000)

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migration-failed")
    assert.deepEqual(setup.copied, [])
    assert.equal(existsSync(riftPath()), true)
    assert.deepEqual(readdirSync(riftPath()), [])
    assert.equal(existsSync(temporaryPath()), false)

    chmodSync(join(legacyPath(), "Icons"), 0o700)
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" }))
    assert.deepEqual(readdirSync(join(legacyPath(), "Icons")), ["custom.png"])
  })
})

describe("describeUserDataSetup", () => {
  it("says which folder the launcher ended up on", () => {
    assert.equal(describeUserDataSetup({ path: "/x", outcome: "fresh", copied: [], cleanedStaleMigration: false }), "Created a new RiftLauncher user data folder.")
    assert.equal(describeUserDataSetup({ path: "/x", outcome: "use-existing", copied: [], cleanedStaleMigration: false }), "Using the existing RiftLauncher user data folder.")
    assert.equal(
      describeUserDataSetup({ path: "/x", outcome: "migrate", copied: ["config.json", "Icons"], cleanedStaleMigration: false }),
      "Copied config.json, Icons from the VS Launcher user data folder, which was left untouched."
    )
    assert.equal(
      describeUserDataSetup({ path: "/x", outcome: "migration-failed", copied: [], cleanedStaleMigration: false }),
      "Could not copy the VS Launcher user data folder. Starting on an empty RiftLauncher folder."
    )
  })

  it("mentions a migration that had to be a copy of nothing", () => {
    assert.equal(describeUserDataSetup({ path: "/x", outcome: "migrate", copied: [], cleanedStaleMigration: false }), "Copied nothing from the VS Launcher user data folder, which was left untouched.")
  })

  it("mentions the leftover it had to discard", () => {
    assert.equal(
      describeUserDataSetup({ path: "/x", outcome: "fresh", copied: [], cleanedStaleMigration: true }),
      "Created a new RiftLauncher user data folder. Discarded an unfinished migration from an earlier run."
    )
  })
})
