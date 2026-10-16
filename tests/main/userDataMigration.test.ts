import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, truncateSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import fse from "fs-extra"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

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
import { DEFAULT_CONFIG_BASE } from "@domain/config/defaults"
import { normalizeModDbVisibility } from "@domain/moddbVisibility"
import { DEFAULT_BACKUPS_FOLDER_NAME, DEFAULT_INSTALLATIONS_FOLDER_NAME, DEFAULT_VERSIONS_FOLDER_NAME, IMPORT_PENDING_MARKER_FILE } from "@domain/userData/migrationPlan"

/** The graceful-fs that fs-extra renames through; it ships without types and is not a dependency of its own. */
const gracefulFs = createRequire(import.meta.url)("graceful-fs") as typeof import("node:fs")

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

/**
 * Makes only `targetPath` report another account as its owner. Mocking `process.getuid` instead
 * would make a link foreign as well, and a check that reads the link rather than its target
 * would still pass.
 */
function spyOnForeignOwnedTarget(targetPath: string): ReturnType<typeof vi.spyOn> {
  const realTarget = realpathSync.native(targetPath)
  const original = fse.statSync.bind(fse)
  return vi.spyOn(fse, "statSync").mockImplementation(((path: string, ...rest: unknown[]) => {
    const stats = (original as (...args: unknown[]) => fse.Stats)(path, ...rest)
    return String(path) === realTarget ? Object.assign(stats, { uid: stats.uid + 1 }) : stats
  }) as typeof fse.statSync)
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

  it("copies the RiftLauncher profile and saved backgrounds while omitting regenerable caches", () => {
    mkdirSync(join(riftPath(), "Cache", "Chromium"), { recursive: true })
    mkdirSync(join(riftPath(), "Cache", "Backgrounds"), { recursive: true })
    mkdirSync(join(riftPath(), "Cache", "Cache_Data"), { recursive: true })
    mkdirSync(join(riftPath(), "Cache", "No_Vary_Search"), { recursive: true })
    mkdirSync(join(riftPath(), "Installations", "survival"), { recursive: true })
    mkdirSync(join(riftPath(), "Installations", "survival", "Cache"), { recursive: true })
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
    writeFileSync(join(riftPath(), "Cache", "Backgrounds", "custom.jpg"), "custom background", "utf8")
    writeFileSync(join(riftPath(), "Cache", "Cache_Data", "index"), "cache data", "utf8")
    writeFileSync(join(riftPath(), "Cache", "No_Vary_Search", "index"), "cache metadata", "utf8")
    writeFileSync(join(riftPath(), "Installations", "survival", "rift.json"), "{}", "utf8")
    writeFileSync(join(riftPath(), "Installations", "survival", "Cache", "world-data"), "keep nested data", "utf8")
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
    // Chromium rebuilds its disk caches, but the launcher stores user-selected backgrounds under
    // Cache too, so only the known regenerable Chromium subfolders are omitted.
    assert.equal(readFileSync(join(dataPath, "Cache", "Backgrounds", "custom.jpg"), "utf8"), "custom background")
    assert.equal(existsSync(join(dataPath, "Cache", "Cache_Data")), false)
    assert.equal(existsSync(join(dataPath, "Cache", "No_Vary_Search")), false)
    assert.equal(readFileSync(join(dataPath, "Installations", "survival", "rift.json"), "utf8"), "{}")
    assert.equal(readFileSync(join(dataPath, "Installations", "survival", "Cache", "world-data"), "utf8"), "keep nested data")
    assert.equal(readFileSync(join(riftPath(), "Cache", "Chromium", "cache.bin"), "utf8"), "cache")
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

  it("refuses a symlinked VS Launcher folder and starts on an empty folder", () => {
    const externalLegacyPath = join(appDataPath, "shared-legacy")
    mkdirSync(join(externalLegacyPath, "Icons"), { recursive: true })
    writeFileSync(join(externalLegacyPath, "config.json"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" }), "utf8")
    writeFileSync(join(externalLegacyPath, "Icons", "custom.png"), "custom icon", "utf8")
    symlinkSync(externalLegacyPath, legacyPath(), process.platform === "win32" ? "junction" : "dir")

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migration-failed")
    assert.deepEqual(setup.copied, [])
    assert.match(setup.failureReason ?? "", /link or junction/i)
    assert.equal(existsSync(riftPath()), true)
    assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
    assert.equal(readFileSync(join(externalLegacyPath, "config.json"), "utf8"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" }))
    assert.equal(existsSync(temporaryPath()), false)
  })

  it("refuses a symlinked Icons folder in the default VS Launcher migration", () => {
    const externalIconsPath = join(appDataPath, "shared-icons")
    mkdirSync(join(legacyPath(), "Icons"), { recursive: true })
    mkdirSync(externalIconsPath, { recursive: true })
    writeFileSync(join(externalIconsPath, "custom.png"), "keep-source-safe", "utf8")
    symlinkSync(externalIconsPath, join(legacyPath(), "Icons", "shared"), process.platform === "win32" ? "junction" : "dir")

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migration-failed")
    assert.deepEqual(setup.copied, [])
    assert.match(setup.failureReason ?? "", /symbolic link that cannot be copied safely/i)
    assert.equal(existsSync(riftPath()), true)
    assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
    assert.equal(existsSync(temporaryPath()), false)
  })

  it.skipIf(process.platform === "win32")("copies legacy config links as files in default migration", () => {
    const externalConfigPath = join(appDataPath, "shared-config.json")
    const originalConfig = JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" })
    writeFileSync(externalConfigPath, originalConfig, "utf8")
    mkdirSync(legacyPath(), { recursive: true })
    symlinkSync("../shared-config.json", join(legacyPath(), "config.json"), "file")

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migrate")
    assert.deepEqual(setup.copied, ["config.json"])
    assert.equal(readFileSync(externalConfigPath, "utf8"), originalConfig)
    assert.equal(lstatSync(join(riftPath(), "config.json")).isSymbolicLink(), false)
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), originalConfig)
  })

  it.skipIf(process.platform === "win32")("refuses a VS Launcher folder that belongs to another user in default migration", () => {
    seedLegacyFolder()
    const getuid = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1)

    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migration-failed")
      assert.deepEqual(setup.copied, [])
      assert.equal(existsSync(riftPath()), true)
      assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
    } finally {
      getuid.mockRestore()
    }
  })

  it("rejects a symlinked legacy VS Launcher folder in portable setup", () => {
    const externalLegacyPath = join(appDataPath, "shared-legacy")
    mkdirSync(join(externalLegacyPath, "Icons"), { recursive: true })
    writeFileSync(join(externalLegacyPath, "config.json"), "{}", "utf8")
    symlinkSync(externalLegacyPath, legacyPath(), process.platform === "win32" ? "junction" : "dir")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /Legacy profile is not a folder/i)
    assert.equal(existsSync(dataPath), false)
    assert.equal(existsSync(`${dataPath}${PORTABLE_MIGRATION_TEMP_SUFFIX}`), false)
  })

  it.skipIf(process.platform === "win32")("rejects a legacy VS Launcher folder that belongs to another user in portable setup", () => {
    seedLegacyFolder()
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    const getuid = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1)

    try {
      assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /Legacy profile belongs to another user/i)
      assert.equal(existsSync(dataPath), false)
    } finally {
      getuid.mockRestore()
    }
  })

  it.skipIf(process.platform === "win32")("rejects a source RiftLauncher profile that belongs to another user in portable setup", () => {
    mkdirSync(riftPath(), { recursive: true })
    writeFileSync(join(riftPath(), "config.json"), '{"source":true}', "utf8")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    const getuid = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1)

    try {
      assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /Profile folder belongs to another user/i)
      assert.equal(existsSync(dataPath), false)
    } finally {
      getuid.mockRestore()
    }
  })

  it.skipIf(process.platform === "win32")("rejects a symlinked source RiftLauncher profile whose target belongs to another user", () => {
    const targetPath = join(appDataPath, "other-user-profile")
    mkdirSync(targetPath, { recursive: true })
    writeFileSync(join(targetPath, "config.json"), '{"source":true}', "utf8")
    symlinkSync(targetPath, riftPath(), "dir")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    const getuid = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1)

    try {
      assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /Profile folder belongs to another user/i)
      assert.equal(existsSync(dataPath), false)
    } finally {
      getuid.mockRestore()
    }
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

  it.skipIf(process.platform === "win32")("rejects a portable data symlink instead of following it", () => {
    mkdirSync(riftPath(), { recursive: true })
    writeFileSync(join(riftPath(), "config.json"), '{"source":true}', "utf8")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    const targetPath = join(appDataPath, "real-portable-data")
    mkdirSync(join(appDataPath, "drive"), { recursive: true })
    mkdirSync(targetPath, { recursive: true })
    writeFileSync(join(targetPath, "config.json"), '{"target":true}', "utf8")
    symlinkSync(targetPath, dataPath, "dir")

    assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /Portable data path is not a folder/i)
    assert.equal(readFileSync(join(targetPath, "config.json"), "utf8"), '{"target":true}')
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), '{"source":true}')
  })

  it.skipIf(process.platform === "win32")("rejects a portable data folder that belongs to another user, so a shared profile is nobody's", () => {
    mkdirSync(riftPath(), { recursive: true })
    writeFileSync(join(riftPath(), "config.json"), '{"source":true}', "utf8")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    mkdirSync(dataPath, { recursive: true })
    writeFileSync(join(dataPath, "config.json"), '{"portable":true}', "utf8")
    const getuid = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1)

    try {
      assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /belongs to another user/i)
      assert.equal(readFileSync(join(dataPath, "config.json"), "utf8"), '{"portable":true}')
    } finally {
      getuid.mockRestore()
    }
  })

  it("rewrites a config.json that starts with a byte order mark instead of leaving the old folders", () => {
    mkdirSync(riftPath(), { recursive: true })
    writeFileSync(
      join(riftPath(), "config.json"),
      `\uFEFF${JSON.stringify({
        defaultInstallationsFolder: join(appDataPath, "RiftLauncherInstallations"),
        defaultVersionsFolder: join(appDataPath, "RiftLauncherGameVersions"),
        backupsFolder: join(appDataPath, "RiftLauncherBackups")
      })}`,
      "utf8"
    )
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)

    setUpPortableUserDataFolder(appDataPath, dataPath)

    assert.deepEqual(JSON.parse(readFileSync(join(dataPath, "config.json"), "utf8")), {
      defaultInstallationsFolder: join(dataPath, "RiftLauncherInstallations"),
      defaultVersionsFolder: join(dataPath, "RiftLauncherGameVersions"),
      backupsFolder: join(dataPath, "RiftLauncherBackups")
    })
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
    assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
    assert.equal(existsSync(temporaryPath()), false)

    chmodSync(join(legacyPath(), "Icons"), 0o700)
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" }))
    assert.deepEqual(readdirSync(join(legacyPath(), "Icons")), ["custom.png"])
  })
})

describe("migration review regressions", () => {
  it.skipIf(process.platform === "win32")("rejects a link to a foreign-owned profile in portable setup even when the link itself is ours", () => {
    const targetPath = join(appDataPath, "other-user-profile")
    mkdirSync(targetPath, { recursive: true })
    writeFileSync(join(targetPath, "config.json"), '{"source":true}', "utf8")
    writeFileSync(join(targetPath, "account-secrets.json"), "sealed:placeholder", "utf8")
    symlinkSync(targetPath, riftPath(), "dir")
    const dataPath = join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    const statSpy = spyOnForeignOwnedTarget(targetPath)

    try {
      assert.throws(() => setUpPortableUserDataFolder(appDataPath, dataPath), /Profile folder belongs to another user/i)
      assert.equal(existsSync(dataPath), false)
    } finally {
      statSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === "win32")("refuses to start on a linked default profile whose target is foreign-owned", () => {
    const targetPath = join(appDataPath, "other-user-profile")
    mkdirSync(targetPath, { recursive: true })
    writeFileSync(join(targetPath, "config.json"), '{"source":true}', "utf8")
    symlinkSync(targetPath, riftPath(), "dir")
    const statSpy = spyOnForeignOwnedTarget(targetPath)

    try {
      assert.throws(() => setUpUserDataFolder(appDataPath), /Profile folder belongs to another user/i)
    } finally {
      statSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === "win32")("uses a linked default profile whose target is the player's own folder", () => {
    const targetPath = join(appDataPath, "own-profile")
    mkdirSync(targetPath, { recursive: true })
    writeFileSync(join(targetPath, "config.json"), '{"source":true}', "utf8")
    symlinkSync(targetPath, riftPath(), "dir")

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "use-existing")
    assert.equal(readFileSync(join(targetPath, "config.json"), "utf8"), '{"source":true}')
  })

  it("refuses an Icons directory link itself in both migration paths", () => {
    const target = join(appDataPath, "external-icons")
    mkdirSync(target)
    mkdirSync(legacyPath())
    symlinkSync(target, join(legacyPath(), "Icons"), process.platform === "win32" ? "junction" : "dir")
    const setup = setUpUserDataFolder(appDataPath)
    assert.equal(setup.outcome, "migration-failed")
    assert.match(setup.failureReason ?? "", /symbolic link/)
    rmSync(riftPath(), { recursive: true })
    assert.throws(() => setUpPortableUserDataFolder(appDataPath, join(appDataPath, "portable")), /symbolic link/)
    assert.deepEqual(readdirSync(target), [])
  })

  it.skipIf(process.platform === "win32")("keeps Icons when a config link is dangling", () => {
    mkdirSync(join(legacyPath(), "Icons"), { recursive: true })
    writeFileSync(join(legacyPath(), "Icons", "custom.png"), "icon")
    symlinkSync("missing.json", join(legacyPath(), "config.json"))
    const setup = setUpUserDataFolder(appDataPath)
    assert.equal(setup.outcome, "migrate")
    assert.deepEqual(setup.copied, ["Icons"])
    assert.equal(readFileSync(join(riftPath(), "Icons", "custom.png"), "utf8"), "icon")
    assert.equal(lstatSync(join(legacyPath(), "config.json")).isSymbolicLink(), true)
  })

  it.skipIf(process.platform === "win32")("rejects a config link to a FIFO without waiting for a writer", () => {
    mkdirSync(legacyPath())
    const fifo = join(appDataPath, "config-pipe")
    execFileSync("mkfifo", [fifo])
    symlinkSync(fifo, join(legacyPath(), "config.json"))
    const setup = setUpUserDataFolder(appDataPath)
    assert.equal(setup.outcome, "migration-failed")
    assert.match(setup.failureReason ?? "", /not a regular file/)
  })

  it.skipIf(process.platform !== "linux")("rejects a config link to a device", () => {
    mkdirSync(legacyPath())
    symlinkSync("/dev/zero", join(legacyPath(), "config.json"))
    const setup = setUpUserDataFolder(appDataPath)
    assert.equal(setup.outcome, "migration-failed")
    assert.match(setup.failureReason ?? "", /not a regular file/)
  })

  it("rejects an oversized regular config before reading it", () => {
    mkdirSync(legacyPath())
    const config = join(legacyPath(), "config.json")
    writeFileSync(config, "")
    truncateSync(config, 16 * 1024 * 1024 + 1)
    const setup = setUpUserDataFolder(appDataPath)
    assert.equal(setup.outcome, "migration-failed")
    assert.match(setup.failureReason ?? "", /16 MiB/)
    assert.ok((setup.failureReason ?? "").endsWith(config), setup.failureReason ?? "")
    assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
  })

  it.skipIf(process.platform === "win32")("refuses an existing foreign-owned default profile just as the portable path does", () => {
    mkdirSync(riftPath())
    writeFileSync(join(riftPath(), "config.json"), "{}")
    const getuid = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1)
    try {
      assert.throws(() => setUpUserDataFolder(appDataPath), /Profile folder belongs to another user/)
      assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), "{}")
    } finally {
      getuid.mockRestore()
    }
  })

  it("names the profile's own config, not the migration copy, when the portable copy is refused", () => {
    mkdirSync(riftPath(), { recursive: true })
    // The refusal names the profile after resolving it, which differs from the temp path when
    // tmpdir() itself sits behind a symlink.
    const configPath = join(realpathSync.native(riftPath()), "config.json")
    writeFileSync(configPath, "")
    truncateSync(configPath, 16 * 1024 * 1024 + 1)

    assert.throws(
      () => setUpPortableUserDataFolder(appDataPath, join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)),
      (error: unknown) => {
        const message = String(error)
        assert.match(message, /16 MiB migration limit/)
        assert.ok(message.endsWith(configPath), message)
        assert.equal(message.includes(PORTABLE_MIGRATION_TEMP_SUFFIX), false, message)
        return true
      }
    )
  })
})

/**
 * A rename onto `destination`, or onto anything inside it, that fails with `code`, `times` times in a row, through the same
 * graceful-fs `renameSync` that `fse.moveSync` ends in. Waiting is skipped and added up instead,
 * so a failure that outlasts the retry window does not make the suite wait for it.
 */
function failRenamesInto(destination: string, code: string, times = Infinity): { attempts: () => number; sleptMs: () => number; restore: () => void } {
  return failRenamesWhere([{ into: destination, code, times }])
}

/** Same, with a failure count of its own for each destination; the attempts are added up over all of them. */
function failRenamesWhere(rules: { into: string; code: string; times: number }[]): { attempts: () => number; sleptMs: () => number; restore: () => void } {
  const original = gracefulFs.renameSync.bind(gracefulFs)
  let attempts = 0
  let slept = 0
  const seen = rules.map(() => 0)
  const faulty = ((from: string, to: string) => {
    const index = rules.findIndex((rule) => to === rule.into || to.startsWith(`${rule.into}${sep}`))
    const rule = rules[index]
    if (rule) {
      attempts += 1
      seen[index] = (seen[index] ?? 0) + 1
      if ((seen[index] ?? 0) <= rule.times) throw Object.assign(new Error(`${rule.code}: operation not permitted, rename '${from}' -> '${to}'`), { code: rule.code, syscall: "rename" })
    }
    return original(from, to)
  }) as typeof gracefulFs.renameSync
  // `fse.moveSync` renames through graceful-fs at call time; `fse.renameSync` is the same function copied when fs-extra loaded.
  const rename = vi.spyOn(gracefulFs, "renameSync").mockImplementation(faulty)
  const renameOfFse = vi.spyOn(fse, "renameSync").mockImplementation(faulty)
  const wait = vi.spyOn(Atomics, "wait").mockImplementation(((_array: Int32Array, _index: number, _value: number, timeout?: number) => {
    slept += timeout ?? 0
    return "timed-out"
  }) as typeof Atomics.wait)
  return {
    attempts: () => attempts,
    sleptMs: () => slept,
    restore: () => {
      rename.mockRestore()
      renameOfFse.mockRestore()
      wait.mockRestore()
    }
  }
}

/** `fse.removeSync` of the given folders fails with EBUSY, as when the scanner that held the rename still holds the copy. */
function lockRemovalOf(...paths: string[]): { restore: () => void } {
  const original = fse.removeSync.bind(fse)
  const remove = vi.spyOn(fse, "removeSync").mockImplementation(((path: string) => {
    if (paths.includes(String(path))) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${String(path)}'`), { code: "EBUSY" })
    return original(path)
  }) as typeof fse.removeSync)
  return { restore: () => remove.mockRestore() }
}

const SEEDED_CONFIG = JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "abc" })

/**
 * The config.json a start that failed to import writes on its own, with nothing chosen by the
 * player, laid out the way the launcher writes it. `overrides` are the player's choices.
 */
function untouchedConfig(overrides: Record<string, unknown> = {}, root = appDataPath): string {
  return JSON.stringify({
    schemaVersion: 3,
    ...DEFAULT_CONFIG_BASE,
    defaultInstallationsFolder: join(root, DEFAULT_INSTALLATIONS_FOLDER_NAME),
    defaultVersionsFolder: join(root, DEFAULT_VERSIONS_FOLDER_NAME),
    backupsFolder: join(root, DEFAULT_BACKUPS_FOLDER_NAME),
    ...overrides
  })
}

describe("a VS Launcher import that fails (#708)", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("absorbs a final rename that fails once with %s", (code) => {
    seedLegacyFolder()
    const fault = failRenamesInto(riftPath(), code, 1)
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migrate")
      assert.deepEqual(setup.copied, ["config.json", "Icons"])
      assert.equal(fault.attempts(), 2)
    } finally {
      fault.restore()
    }
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    assert.deepEqual(readdirSync(riftPath()).sort(), ["Icons", "config.json"])
  })

  it("gives up after a few seconds of a rename that never works, and leaves the marker in an empty folder", () => {
    seedLegacyFolder()
    const fault = failRenamesInto(riftPath(), "EPERM")
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migration-failed")
      assert.equal(setup.importPending, true)
      assert.match(setup.failureReason ?? "", /EPERM/)
      assert.ok(fault.attempts() > 3, "the rename was tried more than a couple of times")
      assert.ok(fault.sleptMs() <= 3_000, `waited ${fault.sleptMs()} ms`)
      assert.ok(fault.sleptMs() >= 2_500, `waited ${fault.sleptMs()} ms`)
    } finally {
      fault.restore()
    }
    assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
    assert.equal(existsSync(temporaryPath()), false)
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), SEEDED_CONFIG)
  })

  it("imports at the next start, and leaves no marker behind", () => {
    seedLegacyFolder()
    const fault = failRenamesInto(riftPath(), "EPERM")
    try {
      assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
    } finally {
      fault.restore()
    }
    // What the launcher itself wrote into the folder in between: its logs and Chromium's state.
    mkdirSync(join(riftPath(), "Logs"))
    writeFileSync(join(riftPath(), "Logs", "info.log"), "a line from the failed start", "utf8")
    writeFileSync(join(riftPath(), "config.json"), untouchedConfig(), "utf8")

    const second = setUpUserDataFolder(appDataPath)

    assert.equal(second.outcome, "migrate")
    assert.deepEqual(second.copied, ["config.json", "Icons"])
    assert.equal(second.importPending, undefined)
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    assert.equal(readFileSync(join(riftPath(), "Icons", "custom.png"), "utf8"), "not really a png")
    assert.equal(readFileSync(join(riftPath(), "Logs", "info.log"), "utf8"), "a line from the failed start")
    assert.equal(existsSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE)), false)
    assert.equal(existsSync(temporaryPath()), false)
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), SEEDED_CONFIG)
  })

  it("keeps the default config.json when the retry fails on Icons, so the next start imports both", () => {
    seedLegacyFolder()
    const first = failRenamesInto(riftPath(), "EPERM")
    try {
      assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
    } finally {
      first.restore()
    }
    const defaults = untouchedConfig()
    writeFileSync(join(riftPath(), "config.json"), defaults, "utf8")

    // Second start: Icons stays locked past the window.
    const second = failRenamesInto(join(riftPath(), "Icons"), "EBUSY")
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migration-failed")
      assert.equal(setup.importPending, true)
    } finally {
      second.restore()
    }
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), defaults, "VS Launcher's config.json must not be in place while Icons is missing")
    assert.equal(existsSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE)), true)

    const third = setUpUserDataFolder(appDataPath)

    assert.equal(third.outcome, "migrate")
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    assert.equal(readFileSync(join(riftPath(), "Icons", "custom.png"), "utf8"), "not really a png")
    assert.equal(existsSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE)), false)
  })

  it("spends one wait budget on all the moves of a retry, not one per entry", () => {
    seedLegacyFolder()
    const first = failRenamesInto(riftPath(), "EPERM")
    try {
      assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
    } finally {
      first.restore()
    }
    // Icons moves after 13 failures (2850 ms of waiting); config.json then never works.
    const second = failRenamesWhere([
      { into: join(riftPath(), "Icons"), code: "EPERM", times: 13 },
      { into: join(riftPath(), "config.json"), code: "EPERM", times: Infinity }
    ])
    try {
      assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
      assert.ok(second.sleptMs() >= 2_850, `waited ${second.sleptMs()} ms`)
      assert.ok(second.sleptMs() <= 3_000, `waited ${second.sleptMs()} ms in all`)
    } finally {
      second.restore()
    }
  })

  it("replaces an Icons folder the failed start left behind instead of merging into it", () => {
    seedLegacyFolder()
    mkdirSync(join(riftPath(), "Icons"), { recursive: true })
    writeFileSync(join(riftPath(), "Icons", "stray.png"), "stray", "utf8")
    writeFileSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE), "", "utf8")

    assert.equal(setUpUserDataFolder(appDataPath).outcome, "migrate")

    assert.deepEqual(readdirSync(join(riftPath(), "Icons")), ["custom.png"])
  })

  it("keeps trying while the failure lasts and never touches VS Launcher's folder", () => {
    seedLegacyFolder()
    const fault = failRenamesInto(riftPath(), "EBUSY")
    try {
      for (let start = 0; start < 3; start += 1) {
        const setup = setUpUserDataFolder(appDataPath)
        assert.equal(setup.outcome, "migration-failed")
        assert.equal(setup.importPending, true)
        assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
      }
    } finally {
      fault.restore()
    }
    assert.deepEqual(readdirSync(legacyPath()).sort(), ["Cache", "Icons", "Logs", "account-secrets.json", "config.json"])
    assert.equal(setUpUserDataFolder(appDataPath).outcome, "migrate")
  })

  it("does not retry a failure that cannot be a lock, and waits for nothing", () => {
    seedLegacyFolder()
    const fault = failRenamesInto(riftPath(), "ENOSPC")
    try {
      assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
      assert.equal(fault.attempts(), 1)
      assert.equal(fault.sleptMs(), 0)
    } finally {
      fault.restore()
    }
    assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
  })

  it("starts on the folder the player has been using when the marker is gone", () => {
    seedLegacyFolder()
    const fault = failRenamesInto(riftPath(), "EPERM")
    try {
      assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
    } finally {
      fault.restore()
    }
    // The first config save that holds something the player chose removes the marker.
    const mine = JSON.stringify({ schemaVersion: 2, lastUsedInstallation: "mine" })
    writeFileSync(join(riftPath(), "config.json"), mine, "utf8")
    rmSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE))

    const second = setUpUserDataFolder(appDataPath)

    assert.equal(second.outcome, "use-existing")
    assert.deepEqual(second.copied, [])
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), mine)
    assert.equal(existsSync(join(riftPath(), "Icons")), false)
  })

  it("keeps a marked folder as it is once VS Launcher's folder is gone", () => {
    mkdirSync(riftPath())
    writeFileSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE), "", "utf8")
    writeFileSync(join(riftPath(), "config.json"), "{}", "utf8")

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "use-existing")
    assert.deepEqual(readdirSync(riftPath()).sort(), ["config.json", IMPORT_PENDING_MARKER_FILE])
  })

  it.skipIf(process.platform === "win32")("writes nothing into a marked folder that belongs to another account", () => {
    seedLegacyFolder()
    mkdirSync(riftPath())
    writeFileSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE), "", "utf8")
    const getuid = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1)
    try {
      assert.throws(() => setUpUserDataFolder(appDataPath), /Profile folder belongs to another user/)
    } finally {
      getuid.mockRestore()
    }
    assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
  })

  it("retries a refusal of a linked VS Launcher folder at every start, and imports once it is a real folder", () => {
    const externalLegacyPath = join(appDataPath, "shared-legacy")
    mkdirSync(externalLegacyPath, { recursive: true })
    writeFileSync(join(externalLegacyPath, "config.json"), SEEDED_CONFIG, "utf8")
    symlinkSync(externalLegacyPath, legacyPath(), process.platform === "win32" ? "junction" : "dir")

    for (let start = 0; start < 2; start += 1) {
      const setup = setUpUserDataFolder(appDataPath)
      assert.equal(setup.outcome, "migration-failed")
      assert.match(setup.failureReason ?? "", /link or junction/i)
      assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
    }

    rmSync(legacyPath(), { recursive: true })
    mkdirSync(legacyPath())
    writeFileSync(join(legacyPath(), "config.json"), SEEDED_CONFIG, "utf8")

    assert.equal(setUpUserDataFolder(appDataPath).outcome, "migrate")
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
  })

  it("still starts when the marker cannot be written, and says no retry is scheduled", () => {
    seedLegacyFolder()
    const fault = failRenamesInto(riftPath(), "EPERM")
    const write = vi.spyOn(fse, "writeFileSync").mockImplementation(((path: string, ...rest: unknown[]) => {
      if (String(path).endsWith(IMPORT_PENDING_MARKER_FILE)) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
      return (gracefulFs.writeFileSync as (...args: unknown[]) => void)(path, ...rest)
    }) as typeof fse.writeFileSync)
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migration-failed")
      assert.equal(setup.importPending, false)
    } finally {
      write.mockRestore()
      fault.restore()
    }
    assert.deepEqual(readdirSync(riftPath()), [])
  })

  it("counts a retried import as done when only the empty temporary folder cannot be removed", () => {
    seedLegacyFolder()
    const fault = failRenamesInto(riftPath(), "EPERM")
    try {
      assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
    } finally {
      fault.restore()
    }
    const original = fse.removeSync.bind(fse)
    const remove = vi.spyOn(fse, "removeSync").mockImplementation(((path: string) => {
      if (path === temporaryPath()) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
      return original(path)
    }) as typeof fse.removeSync)
    try {
      assert.equal(setUpUserDataFolder(appDataPath).outcome, "migrate")
    } finally {
      remove.mockRestore()
    }
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    assert.equal(existsSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE)), false)
    // The next start cleans the leftover.
    assert.equal(setUpUserDataFolder(appDataPath).outcome, "use-existing")
    assert.equal(existsSync(temporaryPath()), false)
  })

  it("still starts when the temporary folder of a failed import cannot be removed either, and imports at the next start", () => {
    seedLegacyFolder()
    const fault = failRenamesInto(riftPath(), "EPERM")
    const lock = lockRemovalOf(temporaryPath())
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migration-failed")
      assert.equal(setup.importPending, true)
      assert.equal(setup.temporaryFolderLeft, true)
      assert.match(setup.failureReason ?? "", /EPERM/)
      assert.match(describeUserDataSetup(setup), /could not be removed/)
    } finally {
      lock.restore()
      fault.restore()
    }
    assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
    assert.equal(existsSync(temporaryPath()), true)
    // Whatever the leftover holds must not reach the profile.
    writeFileSync(join(temporaryPath(), "Icons", "ghost.png"), "from the failed start", "utf8")

    const second = setUpUserDataFolder(appDataPath)

    assert.equal(second.outcome, "migrate")
    assert.equal(second.cleanedStaleMigration, true)
    assert.equal(second.temporaryFolderLeft, undefined)
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    assert.deepEqual(readdirSync(join(riftPath(), "Icons")), ["custom.png"])
    assert.equal(existsSync(temporaryPath()), false)
    assert.equal(existsSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE)), false)
  })

  it("starts on the marked empty folder, and copies nothing into it, while a leftover temporary folder stays locked", () => {
    seedLegacyFolder()
    mkdirSync(join(temporaryPath(), "Icons"), { recursive: true })
    writeFileSync(join(temporaryPath(), "config.json"), JSON.stringify({ half: "written" }), "utf8")
    writeFileSync(join(temporaryPath(), "Icons", "ghost.png"), "from an earlier start", "utf8")
    const lock = lockRemovalOf(temporaryPath())
    try {
      for (let start = 0; start < 2; start += 1) {
        const setup = setUpUserDataFolder(appDataPath)

        assert.equal(setup.outcome, "migration-failed")
        assert.equal(setup.importPending, true)
        assert.equal(setup.temporaryFolderLeft, true)
        assert.equal(setup.cleanedStaleMigration, false)
        assert.match(setup.failureReason ?? "", /could not be removed/)
        assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])
      }
    } finally {
      lock.restore()
    }
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), SEEDED_CONFIG)

    const third = setUpUserDataFolder(appDataPath)

    assert.equal(third.outcome, "migrate")
    assert.equal(third.cleanedStaleMigration, true)
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    assert.deepEqual(readdirSync(join(riftPath(), "Icons")), ["custom.png"])
  })

  it("uses an existing profile as it is when a leftover temporary folder cannot be removed", () => {
    mkdirSync(riftPath(), { recursive: true })
    writeFileSync(join(riftPath(), "config.json"), "{}", "utf8")
    mkdirSync(temporaryPath(), { recursive: true })
    const lock = lockRemovalOf(temporaryPath())
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "use-existing")
      assert.equal(setup.temporaryFolderLeft, true)
      assert.match(describeUserDataSetup(setup), /could not be removed/)
    } finally {
      lock.restore()
    }
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), "{}")
  })

  it("never leaves the marker after an import that worked", () => {
    seedLegacyFolder()

    assert.equal(setUpUserDataFolder(appDataPath).outcome, "migrate")

    assert.equal(existsSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE)), false)
    assert.equal(setUpUserDataFolder(appDataPath).outcome, "use-existing")
    assert.equal(existsSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE)), false)
  })

  it("still lets a RiftLauncher folder without the marker win over VS Launcher's", () => {
    seedLegacyFolder()
    mkdirSync(riftPath())
    writeFileSync(join(riftPath(), "config.json"), "{}", "utf8")

    assert.equal(setUpUserDataFolder(appDataPath).outcome, "use-existing")

    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), "{}")
    assert.equal(existsSync(join(riftPath(), "Icons")), false)
  })

  describe("in a portable profile", () => {
    function portableDataPath(): string {
      return join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    }

    it("absorbs a final rename that fails once", () => {
      seedLegacyFolder()
      const fault = failRenamesInto(portableDataPath(), "EPERM", 1)
      try {
        const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

        assert.equal(setup.outcome, "migrate")
        assert.equal(fault.attempts(), 2)
      } finally {
        fault.restore()
      }
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    })

    it("imports VS Launcher's data instead of copying the empty profile a failed default import left", () => {
      seedLegacyFolder()
      const fault = failRenamesInto(riftPath(), "EPERM")
      try {
        assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
      } finally {
        fault.restore()
      }
      assert.deepEqual(readdirSync(riftPath()), [IMPORT_PENDING_MARKER_FILE])

      const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(setup.outcome, "migrate")
      assert.deepEqual(setup.copied, ["config.json", "Icons"])
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), SEEDED_CONFIG)
      assert.equal(existsSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE)), false)
      assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "use-existing")
    })

    it("starts a fresh portable profile from a marked default profile when VS Launcher's folder is gone", () => {
      mkdirSync(riftPath())
      writeFileSync(join(riftPath(), IMPORT_PENDING_MARKER_FILE), "", "utf8")

      const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(setup.outcome, "fresh")
      assert.deepEqual(readdirSync(portableDataPath()), [])
    })

    it("still copies a default profile that has no marker", () => {
      seedLegacyFolder()
      mkdirSync(riftPath())
      writeFileSync(join(riftPath(), "config.json"), "{}", "utf8")

      const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(setup.outcome, "portable-profile-migrated")
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), "{}")
    })

    it("starts on an empty marked portable profile when the import from VS Launcher's linked folder is refused, and imports once it is fixed", () => {
      const externalLegacyPath = join(appDataPath, "shared-legacy")
      mkdirSync(externalLegacyPath, { recursive: true })
      writeFileSync(join(externalLegacyPath, "config.json"), SEEDED_CONFIG, "utf8")
      symlinkSync(externalLegacyPath, legacyPath(), process.platform === "win32" ? "junction" : "dir")
      assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")

      for (let start = 0; start < 2; start += 1) {
        const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

        assert.equal(setup.outcome, "migration-failed")
        assert.equal(setup.importPending, true)
        assert.match(setup.failureReason ?? "", /link or junction/i)
        assert.deepEqual(readdirSync(portableDataPath()), [IMPORT_PENDING_MARKER_FILE])
      }

      rmSync(legacyPath(), { recursive: true })
      seedLegacyFolder()
      // What the launcher wrote into the folder while it ran empty.
      mkdirSync(join(portableDataPath(), "Logs"))

      const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(setup.outcome, "migrate")
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), SEEDED_CONFIG)
      assert.equal(existsSync(join(portableDataPath(), "Logs")), true)
      assert.equal(existsSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE)), false)
      assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "use-existing")
    })

    it("starts on an empty marked portable profile when copying VS Launcher's folder fails after a failed default import", () => {
      seedLegacyFolder()
      const first = failRenamesInto(riftPath(), "EPERM")
      try {
        assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
      } finally {
        first.restore()
      }
      const second = failRenamesInto(portableDataPath(), "EACCES")
      try {
        const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

        assert.equal(setup.outcome, "migration-failed")
        assert.equal(setup.importPending, true)
        assert.match(setup.failureReason ?? "", /EACCES/)
        assert.ok(second.sleptMs() <= 3_000)
      } finally {
        second.restore()
      }
      assert.deepEqual(readdirSync(portableDataPath()), [IMPORT_PENDING_MARKER_FILE])
      assert.equal(existsSync(`${portableDataPath()}${PORTABLE_MIGRATION_TEMP_SUFFIX}`), false)
      assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), SEEDED_CONFIG)

      assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "migrate")
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), SEEDED_CONFIG)
      assert.equal(readdirSync(portableDataPath()).includes(IMPORT_PENDING_MARKER_FILE), false)
    })

    it("keeps a marked portable profile as it is once VS Launcher's folder is gone, and keeps one the player used", () => {
      mkdirSync(portableDataPath(), { recursive: true })
      writeFileSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE), "", "utf8")
      writeFileSync(join(portableDataPath(), "config.json"), "{}", "utf8")

      assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "use-existing")

      // The player saved something: the marker is gone, so VS Launcher's folder is not read again.
      seedLegacyFolder()
      rmSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE))
      assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "use-existing")
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), "{}")
    })

    it("refuses to start on a rename that never works, leaves no half profile, and imports at the next start", () => {
      seedLegacyFolder()
      const fault = failRenamesInto(portableDataPath(), "EPERM")
      try {
        assert.throws(() => setUpPortableUserDataFolder(appDataPath, portableDataPath()), /Could not copy the existing profile to the portable data folder.*EPERM/)
        assert.ok(fault.sleptMs() <= 3_000)
      } finally {
        fault.restore()
      }
      assert.equal(existsSync(portableDataPath()), false)
      assert.equal(existsSync(`${portableDataPath()}${PORTABLE_MIGRATION_TEMP_SUFFIX}`), false)

      const second = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(second.outcome, "migrate")
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    })

    it("still starts on an empty marked portable profile when the temporary folder of the failed import cannot be removed, and imports at the next start", () => {
      seedLegacyFolder()
      const first = failRenamesInto(riftPath(), "EPERM")
      try {
        assert.equal(setUpUserDataFolder(appDataPath).outcome, "migration-failed")
      } finally {
        first.restore()
      }
      const temporary = `${portableDataPath()}${PORTABLE_MIGRATION_TEMP_SUFFIX}`
      const second = failRenamesInto(portableDataPath(), "EPERM")
      const lock = lockRemovalOf(temporary)
      try {
        const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

        assert.equal(setup.outcome, "migration-failed")
        assert.equal(setup.importPending, true)
        assert.equal(setup.temporaryFolderLeft, true)
        assert.match(setup.failureReason ?? "", /EPERM/)
      } finally {
        lock.restore()
        second.restore()
      }
      assert.deepEqual(readdirSync(portableDataPath()), [IMPORT_PENDING_MARKER_FILE])
      assert.equal(existsSync(temporary), true)
      writeFileSync(join(temporary, "ghost.txt"), "from the failed start", "utf8")

      const third = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(third.outcome, "migrate")
      assert.equal(third.cleanedStaleMigration, true)
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), SEEDED_CONFIG)
      assert.equal(existsSync(join(portableDataPath(), "ghost.txt")), false)
      assert.equal(existsSync(temporary), false)
      assert.equal(existsSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE)), false)
    })

    it("keeps stopping the start with the reason, creating no profile, when a portable import fails with no failed default import behind it, even if the temporary folder cannot be removed", () => {
      seedLegacyFolder()
      const temporary = `${portableDataPath()}${PORTABLE_MIGRATION_TEMP_SUFFIX}`
      const fault = failRenamesInto(portableDataPath(), "EPERM")
      const lock = lockRemovalOf(temporary)
      try {
        assert.throws(() => setUpPortableUserDataFolder(appDataPath, portableDataPath()), /Could not copy the existing profile to the portable data folder.*EPERM/)
      } finally {
        lock.restore()
        fault.restore()
      }
      assert.equal(existsSync(portableDataPath()), false)

      const second = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(second.outcome, "migrate")
      assert.equal(second.cleanedStaleMigration, true)
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    })

    it("stops the start with the reason, and does not copy into it, while a leftover portable temporary folder stays locked", () => {
      seedLegacyFolder()
      const temporary = `${portableDataPath()}${PORTABLE_MIGRATION_TEMP_SUFFIX}`
      mkdirSync(temporary, { recursive: true })
      writeFileSync(join(temporary, "ghost.txt"), "from an earlier start", "utf8")
      const lock = lockRemovalOf(temporary)
      try {
        assert.throws(() => setUpPortableUserDataFolder(appDataPath, portableDataPath()), /Could not copy the existing profile to the portable data folder.*could not be removed/)
      } finally {
        lock.restore()
      }
      assert.equal(existsSync(portableDataPath()), false)

      const second = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(second.outcome, "migrate")
      assert.equal(existsSync(join(portableDataPath(), "ghost.txt")), false)
    })

    it("uses an existing portable profile as it is when a leftover temporary folder cannot be removed", () => {
      mkdirSync(portableDataPath(), { recursive: true })
      writeFileSync(join(portableDataPath(), "config.json"), "{}", "utf8")
      const temporary = `${portableDataPath()}${PORTABLE_MIGRATION_TEMP_SUFFIX}`
      mkdirSync(temporary, { recursive: true })
      const lock = lockRemovalOf(temporary)
      try {
        const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

        assert.equal(setup.outcome, "use-existing")
        assert.equal(setup.temporaryFolderLeft, true)
      } finally {
        lock.restore()
      }
    })
  })
})

/**
 * The decision to import into a marked folder is made at the moment of importing, from what the
 * folder holds: a marker that outlived a profile the player used (a scanner held it open when the
 * save tried to remove it) must not send the next start over their saved config.
 */
describe("a marked folder the player has used (#708)", () => {
  const MARKER = (): string => join(riftPath(), IMPORT_PENDING_MARKER_FILE)

  const answer = (policy: string, answeredVersion = "1.7.0"): Record<string, unknown> => ({ moddbVisibility: { policy, answeredVersion, countedVersions: [] } })

  /** A marked folder whose config.json is `config`, next to a VS Launcher folder whose config.json is `legacyConfig`. */
  function markedFolder(config: string | null, legacyConfig = SEEDED_CONFIG): void {
    seedLegacyFolder()
    writeFileSync(join(legacyPath(), "config.json"), legacyConfig, "utf8")
    mkdirSync(riftPath())
    writeFileSync(MARKER(), "", "utf8")
    if (config !== null) writeFileSync(join(riftPath(), "config.json"), config, "utf8")
  }

  function assertNothingImported(config: string): void {
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), config)
    assert.equal(existsSync(join(riftPath(), "Icons")), false)
    assert.equal(existsSync(temporaryPath()), false)
  }

  it.each([
    ["something else the player changed", { favMods: [5] }, {}],
    ["a ModDB answer next to something else the player changed", { favMods: [5], ...answer("never") }, { moddbVisibility: { policy: "always", answeredVersion: "1.6.0", countedVersions: [] } }]
  ])("keeps the profile and the choice: %s", (_name, choice, legacy) => {
    const mine = untouchedConfig(choice)
    markedFolder(mine, JSON.stringify(legacy))

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "use-existing")
    assert.deepEqual(setup.copied, [])
    assertNothingImported(mine)
    assert.equal(existsSync(MARKER()), false, "the stale marker goes")
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), JSON.stringify(legacy))
  })

  const LEGACY_ALWAYS = { schemaVersion: 2, lastUsedInstallation: "abc", moddbVisibility: { policy: "always", answeredVersion: "1.6.0", countedVersions: ["1.6.0"] } }
  const LEGACY_NEVER = { schemaVersion: 2, lastUsedInstallation: "abc", moddbVisibility: { policy: "never", answeredVersion: "1.6.0", countedVersions: [] } }

  /** The config.json in `folder`, as the next session would read it. */
  const importedConfig = (folder: string): Record<string, unknown> => JSON.parse(readFileSync(join(folder, "config.json"), "utf8")) as Record<string, unknown>

  it.each([
    ["never, while VS Launcher's config says always", answer("never"), LEGACY_ALWAYS],
    ["always, while VS Launcher's config says never", answer("always"), LEGACY_NEVER],
    ["a yes for this version only", answer("once"), LEGACY_NEVER],
    ["not this time", answer("ask"), LEGACY_ALWAYS],
    ["a policy changed on the settings page", answer("never", ""), LEGACY_ALWAYS],
    ["a count that only an answer can owe", { moddbVisibility: { policy: "always", answeredVersion: "1.7.0", countedVersions: ["1.7.0"] } }, LEGACY_NEVER],
    ["an answer over a VS Launcher config that has no such field", answer("never"), { schemaVersion: 2, lastUsedInstallation: "abc" }]
  ])("imports at the next start and carries the ModDB answer over: %s", (_name, choice, legacy) => {
    markedFolder(untouchedConfig(choice), JSON.stringify(legacy))

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migrate")
    assert.deepEqual(setup.copied, ["config.json", "Icons"])
    const imported = importedConfig(riftPath())
    assert.deepEqual(imported.moddbVisibility, choice.moddbVisibility)
    assert.equal(normalizeModDbVisibility(imported.moddbVisibility, "1.7.0").policy, (choice.moddbVisibility as { policy: string }).policy)
    assert.equal(imported.lastUsedInstallation, "abc", "VS Launcher's own data is what gets imported")
    assert.equal(readFileSync(join(riftPath(), "Icons", "custom.png"), "utf8"), "not really a png")
    assert.equal(existsSync(MARKER()), false)
    assert.equal(existsSync(temporaryPath()), false)
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), JSON.stringify(legacy), "VS Launcher's folder is only read")
  })

  it("leaves VS Launcher's config byte for byte when the marked folder holds the default answer", () => {
    markedFolder(untouchedConfig(), JSON.stringify(LEGACY_ALWAYS))

    assert.equal(setUpUserDataFolder(appDataPath).outcome, "migrate")

    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), JSON.stringify(LEGACY_ALWAYS))
  })

  it("fails the import for this start, and touches nothing, when the current config.json cannot be read for its answer", () => {
    const mine = untouchedConfig(answer("never"))
    markedFolder(mine, JSON.stringify(LEGACY_ALWAYS))
    const original = fse.readFileSync.bind(fse)
    let reads = 0
    // The start-time check reads it fine; the read made for the import fails.
    const read = vi.spyOn(fse, "readFileSync").mockImplementation(((path: string, ...rest: unknown[]) => {
      if (String(path) === join(riftPath(), "config.json") && (reads += 1) > 1) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" })
      return (original as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fse.readFileSync)
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migration-failed")
      assert.equal(setup.importPending, true)
      assert.match(setup.failureReason ?? "", /EIO/)
    } finally {
      read.mockRestore()
    }
    assertNothingImported(mine)
    assert.equal(existsSync(MARKER()), true)

    const next = setUpUserDataFolder(appDataPath)

    assert.equal(next.outcome, "migrate")
    assert.equal((importedConfig(riftPath()).moddbVisibility as { policy: string }).policy, "never")
  })

  it("fails the import for this start, and touches nothing, when the patched config.json cannot be written", () => {
    const mine = untouchedConfig(answer("never"))
    markedFolder(mine, JSON.stringify(LEGACY_ALWAYS))
    const original = fse.writeFileSync.bind(fse)
    const write = vi.spyOn(fse, "writeFileSync").mockImplementation(((path: string, data: unknown, ...rest: unknown[]) => {
      if (String(path) === join(temporaryPath(), "config.json") && String(data).includes('"never"')) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
      return (original as (...args: unknown[]) => void)(path, data, ...rest)
    }) as typeof fse.writeFileSync)
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migration-failed")
      assert.equal(setup.importPending, true)
      assert.match(setup.failureReason ?? "", /ENOSPC/)
    } finally {
      write.mockRestore()
    }
    assertNothingImported(mine)
    assert.equal(existsSync(MARKER()), true)

    assert.equal(setUpUserDataFolder(appDataPath).outcome, "migrate")
    assert.equal((importedConfig(riftPath()).moddbVisibility as { policy: string }).policy, "never")
  })

  it("keeps the marked folder's config.json, and its answer, byte for byte when the rename of config.json never works, and imports with the answer at the next start", () => {
    const mine = untouchedConfig(answer("never"))
    markedFolder(mine, JSON.stringify(LEGACY_ALWAYS))
    const fault = failRenamesWhere([{ into: join(riftPath(), "config.json"), code: "EPERM", times: Infinity }])
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migration-failed")
      assert.equal(setup.importPending, true)
      assert.ok(fault.sleptMs() <= 3_000, "the wait stays within the shared budget")
    } finally {
      fault.restore()
    }
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), mine, "the answer is still there")
    assert.equal(existsSync(MARKER()), true)

    const next = setUpUserDataFolder(appDataPath)

    assert.equal(next.outcome, "migrate")
    assert.equal((importedConfig(riftPath()).moddbVisibility as { policy: string }).policy, "never")
    assert.equal(importedConfig(riftPath()).lastUsedInstallation, "abc")
    assert.equal(existsSync(MARKER()), false)
  })

  it.each([
    ["is not an object", "[]"],
    ["is not JSON", '{"schemaVersion": 2, "last']
  ])("fails the import for this start, and touches nothing, when VS Launcher's config.json %s and there is an answer to carry", (_name, legacy) => {
    const mine = untouchedConfig(answer("never"))
    markedFolder(mine, legacy)

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migration-failed")
    assert.equal(setup.importPending, true)
    assertNothingImported(mine)
    assert.equal(existsSync(MARKER()), true)
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), legacy)
  })

  it("keeps the 16 MiB limit on the config.json it patches", () => {
    const mine = untouchedConfig(answer("never"))
    // 1e5 is three bytes in this file and six once it is written back, so the patched copy outgrows the limit.
    const legacy = `{"favMods":[${Array.from({ length: 4_000_000 }, () => "1e5").join(",")}]}`
    assert.ok(Buffer.byteLength(legacy) <= 16 * 1024 * 1024)
    markedFolder(mine, legacy)

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migration-failed")
    assert.match(setup.failureReason ?? "", /16 MiB migration limit/)
    assertNothingImported(mine)
    assert.equal(existsSync(MARKER()), true)
  })

  it("counts the import as done when only the removal of the marker fails, and drops the stale marker at the next start", () => {
    markedFolder(untouchedConfig(), SEEDED_CONFIG)
    const lock = lockRemovalOf(MARKER())
    try {
      const setup = setUpUserDataFolder(appDataPath)

      assert.equal(setup.outcome, "migrate")
      assert.deepEqual(setup.copied, ["config.json", "Icons"])
      assert.equal(setup.importPending, undefined)
    } finally {
      lock.restore()
    }
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    assert.equal(existsSync(MARKER()), true)
    assert.equal(existsSync(temporaryPath()), false)

    assert.equal(setUpUserDataFolder(appDataPath).outcome, "use-existing")
    assert.equal(existsSync(MARKER()), false)
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
  })

  it("still starts, and keeps the profile, when the stale marker cannot be removed, and removes it once it can", () => {
    const mine = untouchedConfig({ favMods: [5], ...answer("never") })
    markedFolder(mine)
    const lock = lockRemovalOf(MARKER())
    try {
      for (let start = 0; start < 2; start += 1) {
        const setup = setUpUserDataFolder(appDataPath)

        assert.equal(setup.outcome, "use-existing")
        assertNothingImported(mine)
        assert.equal(existsSync(MARKER()), true)
      }
    } finally {
      lock.restore()
    }

    assert.equal(setUpUserDataFolder(appDataPath).outcome, "use-existing")
    assert.equal(existsSync(MARKER()), false)
    assertNothingImported(mine)
  })

  it("imports into a marked folder whose config.json is still the untouched one, whatever a first start filled in by itself", () => {
    const filledIn = untouchedConfig({ schemaVersion: 2, window: { width: 900, height: 600, x: 10, y: 20, maximized: true }, lastSeenChangelogVersion: "1.7.0" })
    markedFolder(filledIn)

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "migrate")
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
    assert.equal(readFileSync(join(riftPath(), "Icons", "custom.png"), "utf8"), "not really a png")
    assert.equal(existsSync(MARKER()), false)
  })

  it("imports into a marked folder that has no config.json at all", () => {
    markedFolder(null)

    assert.equal(setUpUserDataFolder(appDataPath).outcome, "migrate")
    assert.equal(readFileSync(join(riftPath(), "config.json"), "utf8"), SEEDED_CONFIG)
  })

  it.each([
    ["a truncated document", '{"schemaVersion": 3, "favMo'],
    ["an empty file", ""],
    ["valid JSON that is not an object", "[]"],
    ["a null document", "null"]
  ])("never imports over a config.json that cannot be read as a config: %s", (_name, unreadable) => {
    markedFolder(unreadable)

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "use-existing")
    assert.equal(setup.importPending, undefined)
    assertNothingImported(unreadable)
    assert.equal(existsSync(MARKER()), true, "left for a later start, which can read the file")
    assert.equal(readFileSync(join(legacyPath(), "config.json"), "utf8"), SEEDED_CONFIG)
  })

  it("never imports over a config.json that cannot be opened as a file", () => {
    markedFolder(null)
    mkdirSync(join(riftPath(), "config.json"))

    const setup = setUpUserDataFolder(appDataPath)

    assert.equal(setup.outcome, "use-existing")
    assert.equal(existsSync(join(riftPath(), "Icons")), false)
    assert.equal(existsSync(MARKER()), true)
  })

  describe("in a portable profile", () => {
    function portableDataPath(): string {
      return join(appDataPath, "drive", PORTABLE_USER_DATA_FOLDER)
    }

    function markedPortableFolder(config: string): void {
      seedLegacyFolder()
      mkdirSync(portableDataPath(), { recursive: true })
      writeFileSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE), "", "utf8")
      writeFileSync(join(portableDataPath(), "config.json"), config, "utf8")
    }

    it("keeps a portable profile whose stale marker could not be removed, and removes the marker once it can", () => {
      const mine = untouchedConfig({ favMods: [5], ...answer("never") }, portableDataPath())
      markedPortableFolder(mine)
      const lock = lockRemovalOf(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE))
      try {
        const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

        assert.equal(setup.outcome, "use-existing")
      } finally {
        lock.restore()
      }
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), mine)
      assert.equal(existsSync(join(portableDataPath(), "Icons")), false)

      assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "use-existing")
      assert.equal(existsSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE)), false)
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), mine)
    })

    it("imports into a marked portable profile whose config.json is still the untouched one", () => {
      markedPortableFolder(untouchedConfig({ lastSeenChangelogVersion: "1.7.0" }, portableDataPath()))

      assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "migrate")
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), SEEDED_CONFIG)
      assert.equal(existsSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE)), false)
    })

    it("never imports over an unreadable config.json in a marked portable profile", () => {
      markedPortableFolder('{"schemaVersion": 3, "favMo')

      assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "use-existing")
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), '{"schemaVersion": 3, "favMo')
      assert.equal(existsSync(join(portableDataPath(), "Icons")), false)
    })

    it("carries the ModDB answer of a marked portable profile into the import", () => {
      markedPortableFolder(untouchedConfig(answer("never"), portableDataPath()))
      writeFileSync(join(legacyPath(), "config.json"), JSON.stringify(LEGACY_ALWAYS), "utf8")

      const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(setup.outcome, "migrate")
      assert.deepEqual(importedConfig(portableDataPath()).moddbVisibility, answer("never").moddbVisibility)
      assert.equal(importedConfig(portableDataPath()).lastUsedInstallation, "abc")
      assert.equal(existsSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE)), false)
    })

    it("fails the import into a marked portable profile, and touches nothing, when the answer cannot be carried", () => {
      const mine = untouchedConfig(answer("never"), portableDataPath())
      markedPortableFolder(mine)
      writeFileSync(join(legacyPath(), "config.json"), "[]", "utf8")

      const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(setup.outcome, "migration-failed")
      assert.equal(setup.importPending, true)
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), mine)
      assert.equal(existsSync(join(portableDataPath(), "Icons")), false)
      assert.equal(existsSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE)), true)
    })

    it("keeps a marked portable profile's config.json, and its answer, when the rename of config.json never works, and imports with the answer at the next start", () => {
      const mine = untouchedConfig(answer("never"), portableDataPath())
      markedPortableFolder(mine)
      writeFileSync(join(legacyPath(), "config.json"), JSON.stringify(LEGACY_ALWAYS), "utf8")
      const fault = failRenamesWhere([{ into: join(portableDataPath(), "config.json"), code: "EPERM", times: Infinity }])
      try {
        assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "migration-failed")
      } finally {
        fault.restore()
      }
      assert.equal(readFileSync(join(portableDataPath(), "config.json"), "utf8"), mine)
      assert.equal(existsSync(join(portableDataPath(), IMPORT_PENDING_MARKER_FILE)), true)

      assert.equal(setUpPortableUserDataFolder(appDataPath, portableDataPath()).outcome, "migrate")
      assert.deepEqual(importedConfig(portableDataPath()).moddbVisibility, answer("never").moddbVisibility)
      assert.equal(importedConfig(portableDataPath()).lastUsedInstallation, "abc")
    })

    it("carries the ModDB answer of a marked default profile into the import that replaces it", () => {
      markedFolder(untouchedConfig(answer("never")), JSON.stringify(LEGACY_ALWAYS))

      const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(setup.outcome, "migrate")
      assert.deepEqual(importedConfig(portableDataPath()).moddbVisibility, answer("never").moddbVisibility)
      assert.equal(importedConfig(portableDataPath()).lastUsedInstallation, "abc")
    })

    it("copies a default profile the player used, marker still there or not, instead of importing VS Launcher's folder", () => {
      seedLegacyFolder()
      const mine = untouchedConfig({ favMods: [5], ...answer("never") })
      mkdirSync(riftPath())
      writeFileSync(MARKER(), "", "utf8")
      writeFileSync(join(riftPath(), "config.json"), mine, "utf8")

      const setup = setUpPortableUserDataFolder(appDataPath, portableDataPath())

      assert.equal(setup.outcome, "portable-profile-migrated")
      // The copy rewrites the default folder paths, so the answer is read rather than the bytes compared.
      assert.equal(JSON.parse(readFileSync(join(portableDataPath(), "config.json"), "utf8")).moddbVisibility.policy, "never")
      assert.equal(existsSync(join(portableDataPath(), "Icons")), false)
    })
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

  it("says the import will be tried again when the marker is in place", () => {
    assert.equal(
      describeUserDataSetup({ path: "/x", outcome: "migration-failed", copied: [], cleanedStaleMigration: false, failureReason: "EPERM: rename", importPending: true }),
      "Could not copy the VS Launcher user data folder (EPERM: rename). Starting on an empty RiftLauncher folder, and trying the import again at the next start."
    )
  })

  it("says a temporary folder is left to be cleaned at the next start", () => {
    assert.equal(
      describeUserDataSetup({ path: "/x", outcome: "use-existing", copied: [], cleanedStaleMigration: false, temporaryFolderLeft: true }),
      "Using the existing RiftLauncher user data folder. A temporary copy folder could not be removed and is cleaned at the next start."
    )
  })

  it("includes the failure reason when a migration fails", () => {
    assert.equal(
      describeUserDataSetup({
        path: "/x",
        outcome: "migration-failed",
        copied: [],
        cleanedStaleMigration: false,
        failureReason: "Legacy profile belongs to another user: /appData/VSLauncher"
      }),
      "Could not copy the VS Launcher user data folder (Legacy profile belongs to another user: /appData/VSLauncher). Starting on an empty RiftLauncher folder."
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
