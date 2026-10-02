import assert from "node:assert/strict"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import {
  describeUserDataSetup,
  getPortableUserDataPaths,
  isWindowsPathEqualOrWithin,
  LEGACY_USER_DATA_FOLDER,
  MIGRATION_TEMP_FOLDER,
  PORTABLE_MIGRATION_TEMP_SUFFIX,
  PORTABLE_MARKER_FILE,
  PORTABLE_USER_DATA_FOLDER,
  RIFT_USER_DATA_FOLDER,
  setUpPortableUserDataFolder,
  setUpUserDataFolder
} from "@src/main/userDataMigration"

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

  it("places the Windows marker and profile outside the install folder", () => {
    assert.deepEqual(getPortableUserDataPaths("win32", "D:\\Games\\RiftLauncher\\RiftLauncher.exe", undefined), {
      markerPath: `D:\\Games\\${PORTABLE_MARKER_FILE}`,
      dataPath: `D:\\Games\\${PORTABLE_USER_DATA_FOLDER}`,
      installPath: "D:\\Games\\RiftLauncher"
    })
  })

  it("places the Linux marker and profile beside the AppImage", () => {
    assert.deepEqual(getPortableUserDataPaths("linux", "", "/mnt/games/riftlauncher.AppImage"), {
      markerPath: `/mnt/games/${PORTABLE_MARKER_FILE}`,
      dataPath: `/mnt/games/${PORTABLE_USER_DATA_FOLDER}`
    })
    assert.equal(getPortableUserDataPaths("linux", "", "riftlauncher.AppImage"), null)
  })

  it("copies the full RiftLauncher profile into portable data and leaves the source intact", () => {
    mkdirSync(join(riftPath(), "Cache", "Chromium"), { recursive: true })
    const originalConfig = JSON.stringify({
      defaultInstallationsFolder: join(appDataPath, "RiftLauncherInstallations"),
      defaultVersionsFolder: join(appDataPath, "RiftLauncherGameVersions"),
      backupsFolder: join(appDataPath, "player-chosen-backups")
    })
    const originalBackup = JSON.stringify({
      defaultInstallationsFolder: join(appDataPath, "RiftLauncherInstallations"),
      defaultVersionsFolder: join(appDataPath, "RiftLauncherGameVersions"),
      backupsFolder: join(appDataPath, "RiftLauncherBackups")
    })
    writeFileSync(join(riftPath(), "config.json"), originalConfig, "utf8")
    writeFileSync(join(riftPath(), "config.pre-migration.bak.json"), originalBackup, "utf8")
    writeFileSync(join(riftPath(), "Cache", "Chromium", "cache.bin"), "cache", "utf8")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    const setup = setUpPortableUserDataFolder(appDataPath, dataPath)

    assert.equal(setup.path, dataPath)
    assert.equal(setup.outcome, "portable-profile-migrated")
    assert.deepEqual(JSON.parse(readFileSync(join(dataPath, "config.json"), "utf8")), {
      defaultInstallationsFolder: join(dataPath, "RiftLauncherInstallations"),
      defaultVersionsFolder: join(dataPath, "RiftLauncherGameVersions"),
      backupsFolder: join(appDataPath, "player-chosen-backups")
    })
    assert.deepEqual(JSON.parse(readFileSync(join(dataPath, "config.pre-migration.bak.json"), "utf8")), {
      defaultInstallationsFolder: join(dataPath, "RiftLauncherInstallations"),
      defaultVersionsFolder: join(dataPath, "RiftLauncherGameVersions"),
      backupsFolder: join(dataPath, "RiftLauncherBackups")
    })
    assert.equal(readFileSync(join(dataPath, "Cache", "Chromium", "cache.bin"), "utf8"), "cache")
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), originalConfig)
    assert.equal(readFileSync(join(riftPath(), "config.pre-migration.bak.json"), "utf8"), originalBackup)
    assert.equal(existsSync(`${dataPath}${PORTABLE_MIGRATION_TEMP_SUFFIX}`), false)
  })

  it.skipIf(process.platform === "win32")("copies a linked source profile without writing through its symlink", () => {
    const sourcePath = join(appDataPath, "linked-profile-source")
    mkdirSync(sourcePath, { recursive: true })
    const originalConfig = JSON.stringify({ defaultInstallationsFolder: join(appDataPath, "RiftLauncherInstallations") })
    writeFileSync(join(sourcePath, "config.json"), originalConfig, "utf8")
    symlinkSync(sourcePath, riftPath(), "dir")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    setUpPortableUserDataFolder(appDataPath, dataPath)

    assert.equal(lstatSync(riftPath()).isSymbolicLink(), true)
    assert.equal(lstatSync(dataPath).isSymbolicLink(), false)
    assert.equal(readFileSync(join(sourcePath, "config.json"), "utf8"), originalConfig)
    assert.deepEqual(JSON.parse(readFileSync(join(dataPath, "config.json"), "utf8")), {
      defaultInstallationsFolder: join(dataPath, "RiftLauncherInstallations")
    })
  })

  it.skipIf(process.platform === "win32")("copies linked config files without changing their targets", () => {
    const externalConfigPath = join(appDataPath, "shared-config")
    const originalConfig = JSON.stringify({ defaultInstallationsFolder: join(appDataPath, "RiftLauncherInstallations") })
    const originalBackup = Buffer.from([0x7b, 0xff, 0x7d])
    writeFileSync(externalConfigPath, originalConfig, "utf8")
    writeFileSync(join(appDataPath, "shared-backup"), originalBackup)
    mkdirSync(riftPath(), { recursive: true })
    symlinkSync("../shared-config", join(riftPath(), "config.json"), "file")
    symlinkSync("../shared-backup", join(riftPath(), "config.pre-migration.bak.json"), "file")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    setUpPortableUserDataFolder(appDataPath, dataPath)

    assert.equal(readFileSync(externalConfigPath, "utf8"), originalConfig)
    assert.deepEqual(readFileSync(join(appDataPath, "shared-backup")), originalBackup)
    assert.equal(lstatSync(join(dataPath, "config.json")).isSymbolicLink(), false)
    assert.equal(lstatSync(join(dataPath, "config.pre-migration.bak.json")).isSymbolicLink(), false)
    assert.deepEqual(JSON.parse(readFileSync(join(dataPath, "config.json"), "utf8")), { defaultInstallationsFolder: join(dataPath, "RiftLauncherInstallations") })
    assert.deepEqual(readFileSync(join(dataPath, "config.pre-migration.bak.json")), originalBackup)
  })

  it.skipIf(process.platform === "win32")("rejects a linked secret file without writing to its target", () => {
    const externalSecretPath = join(appDataPath, "shared-account-secrets.json")
    const originalSecret = "sealed:keep-source-safe"
    writeFileSync(externalSecretPath, originalSecret, "utf8")
    mkdirSync(riftPath(), { recursive: true })
    symlinkSync("../shared-account-secrets.json", join(riftPath(), "account-secrets.json"), "file")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /symbolic link that cannot be copied safely/i)
    assert.equal(readFileSync(externalSecretPath, "utf8"), originalSecret)
    assert.equal(existsSync(dataPath), false)
    assert.equal(existsSync(`${dataPath}${PORTABLE_MIGRATION_TEMP_SUFFIX}`), false)
  })

  it.skipIf(process.platform === "win32")("copies legacy config links as files and leaves the VS Launcher source intact", () => {
    const externalConfigPath = join(appDataPath, "shared-config.json")
    const originalConfig = JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" })
    writeFileSync(externalConfigPath, originalConfig, "utf8")
    mkdirSync(legacyPath(), { recursive: true })
    symlinkSync("../shared-config.json", join(legacyPath(), "config.json"), "file")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    setUpPortableUserDataFolder(appDataPath, dataPath)

    assert.equal(readFileSync(externalConfigPath, "utf8"), originalConfig)
    assert.equal(lstatSync(join(dataPath, "config.json")).isSymbolicLink(), false)
    assert.equal(readFileSync(join(dataPath, "config.json"), "utf8"), originalConfig)
  })

  it("rejects symlinks inside the legacy Icons folder", () => {
    const externalIconsPath = join(appDataPath, "shared-icons")
    mkdirSync(join(legacyPath(), "Icons"), { recursive: true })
    mkdirSync(externalIconsPath, { recursive: true })
    writeFileSync(join(externalIconsPath, "custom.png"), "keep-source-safe", "utf8")
    symlinkSync(externalIconsPath, join(legacyPath(), "Icons", "shared"), process.platform === "win32" ? "junction" : "dir")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /legacy profile contains a symbolic link/i)
    assert.equal(readFileSync(join(externalIconsPath, "custom.png"), "utf8"), "keep-source-safe")
    assert.equal(existsSync(dataPath), false)
    assert.equal(existsSync(`${dataPath}${PORTABLE_MIGRATION_TEMP_SUFFIX}`), false)
  })

  it.skipIf(process.platform === "win32")("discards stale Chromium lock links during portable migration", () => {
    mkdirSync(riftPath(), { recursive: true })
    symlinkSync("stale-host-1234", join(riftPath(), "SingletonLock"), "file")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    setUpPortableUserDataFolder(appDataPath, dataPath)

    assert.equal(existsSync(join(dataPath, "SingletonLock")), false)
    assert.equal(lstatSync(join(riftPath(), "SingletonLock")).isSymbolicLink(), true)
  })

  it.skipIf(process.platform !== "win32")("rejects a linked secret folder without writing to its target", () => {
    const externalSecretsPath = join(appDataPath, "shared-secrets")
    const originalSecret = "sealed:keep-source-safe"
    mkdirSync(externalSecretsPath, { recursive: true })
    writeFileSync(join(externalSecretsPath, "account-secrets.json"), originalSecret, "utf8")
    mkdirSync(riftPath(), { recursive: true })
    symlinkSync(externalSecretsPath, join(riftPath(), "Secrets"), "junction")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /symbolic link that cannot be copied safely/i)
    assert.equal(readFileSync(join(externalSecretsPath, "account-secrets.json"), "utf8"), originalSecret)
    assert.equal(existsSync(dataPath), false)
    assert.equal(existsSync(`${dataPath}${PORTABLE_MIGRATION_TEMP_SUFFIX}`), false)
  })

  it("keeps a non-empty portable profile and does not overwrite it from appData", () => {
    mkdirSync(riftPath(), { recursive: true })
    writeFileSync(join(riftPath(), "config.json"), '{"source":true}', "utf8")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    mkdirSync(dataPath, { recursive: true })
    writeFileSync(join(dataPath, "config.json"), '{"portable":true}', "utf8")

    const setup = setUpPortableUserDataFolder(appDataPath, dataPath)

    assert.equal(setup.outcome, "use-existing")
    assert.equal(readFileSync(join(dataPath, "config.json"), "utf8"), '{"portable":true}')
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), '{"source":true}')
  })

  it("uses only the existing VS Launcher migration allowlist when no RiftLauncher profile exists", () => {
    seedLegacyFolder()
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    const setup = setUpPortableUserDataFolder(appDataPath, dataPath)

    assert.equal(setup.outcome, "migrate")
    assert.deepEqual(setup.copied, ["config.json", "Icons"])
    assert.deepEqual(readdirSync(dataPath).sort(), ["Icons", "config.json"])
    assert.equal(existsSync(join(legacyPath(), "account-secrets.json")), true)
  })

  it("does not replace a portable data path that is a file", () => {
    mkdirSync(riftPath(), { recursive: true })
    writeFileSync(join(riftPath(), "config.json"), "keep me", "utf8")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    mkdirSync(join(appDataPath, "drive"), { recursive: true })
    writeFileSync(dataPath, "not a folder", "utf8")

    assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /not a folder/i)
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), "keep me")
    assert.equal(readFileSync(dataPath, "utf8"), "not a folder")
  })

  it("rejects a Windows portable data path that equals the install folder", () => {
    assert.equal(isWindowsPathEqualOrWithin("D:\\Games\\RiftLauncherData", "d:\\games\\riftlauncherdata"), true)
    assert.equal(isWindowsPathEqualOrWithin("D:\\Games\\RiftLauncher", "D:\\Games\\RiftLauncherData"), false)
    assert.throws(() => setUpPortableUserDataFolder(appDataPath, "D:\\Games\\RiftLauncherData", "d:\\games\\riftlauncherdata"), /overlaps the NSIS install folder/i)
  })

  it("rejects a Windows migration staging path that equals the install folder", () => {
    assert.throws(() => setUpPortableUserDataFolder(appDataPath, "D:\\Games\\RiftLauncherData", "d:\\games\\riftlauncherdata.migrating"), /migration folder overlaps the NSIS install folder/i)
  })

  it("rejects a Windows migration folder that contains the install folder", () => {
    assert.throws(() => setUpPortableUserDataFolder(appDataPath, "D:\\Games\\RiftLauncherData", "D:\\Games\\RiftLauncherData.migrating\\Launcher"), /overlaps the NSIS install folder/i)
  })

  it.skipIf(process.platform !== "win32")("rejects a migration junction that points inside the NSIS install folder", () => {
    const installPath = join(appDataPath, "Games", "Install")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    const temporaryPath = `${dataPath}${PORTABLE_MIGRATION_TEMP_SUFFIX}`
    mkdirSync(installPath, { recursive: true })
    writeFileSync(join(installPath, "RiftLauncher.exe"), "keep", "utf8")
    mkdirSync(join(appDataPath, "drive"), { recursive: true })
    symlinkSync(installPath, temporaryPath, "junction")

    assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath, installPath), /overlaps the NSIS install folder/i)
    assert.equal(readFileSync(join(installPath, "RiftLauncher.exe"), "utf8"), "keep")
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
