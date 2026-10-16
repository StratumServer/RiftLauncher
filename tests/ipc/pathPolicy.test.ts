import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import fse from "fs-extra"

import { describeHeldFolder, findHeldManagedFolder } from "../../src/renderer/src/features/installations/adapters/nesting"
import { toFolderPlatform } from "@domain/paths"

/**
 * Boundary coverage for the managed path policy (#11).
 *
 * `src/ipc/pathPolicy.ts` reaches two modules that cannot run under plain Node:
 * `electron` (for the launcher's own folders and the protected path list) and
 * the config manager (which itself imports `electron` at module load). Both are
 * mocked here rather than through `helpers/electronMock`, because this file
 * needs `getAppPath` and per-name `getPath` answers that the shared helper does
 * not model: it returns one temp folder for every name, which would make
 * `userData`, `appData` and `home` indistinguishable and quietly collapse the
 * protected path assertions into one.
 *
 * Every fixture is a real folder tree. The policy stats the file system twice
 * (existence, then a symlink walk over every existing ancestor), so paths that
 * exist only as strings would exercise a different branch than production does.
 */
const electronState = vi.hoisted(() => ({ userData: "", appData: "", home: "", appPath: "" }))
const configState = vi.hoisted(() => ({ config: null as unknown }))

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "userData") return electronState.userData
      if (name === "appData") return electronState.appData
      if (name === "home") return electronState.home
      throw new Error(`Unexpected app.getPath(${name}) in test`)
    },
    getAppPath: (): string => electronState.appPath
  }
}))

vi.mock("@src/config/configManager", () => ({
  getConfig: (): Promise<ConfigType> => Promise.resolve(configState.config as ConfigType)
}))

type PathPolicyModule = typeof import("@src/ipc/pathPolicy")

/** A uuid the restore workspace name check accepts. */
const RESTORE_TOKEN = "0f8fad5b-d9cb-469f-a165-70867728950e"

let temporaryRoot: string
let policy: PathPolicyModule

/** Fixture layout, resolved to absolute paths once the temp root exists. */
let managedFolder: string
let versionsFolder: string
let backupsFolder: string
let userDataFolder: string
let outsideFolder: string

/** `Main`, an installation inside the configured installations folder. */
let mainInstallation: string
/** `Custom`, an installation the user put outside every configured folder. */
let customInstallation: string
let gameVersion: string
let backupArchive: string

function buildConfig(overrides: Partial<ConfigType> = {}): ConfigType {
  return {
    defaultInstallationsFolder: managedFolder,
    defaultVersionsFolder: versionsFolder,
    backupsFolder,
    installations: [
      { path: mainInstallation, backups: [{ id: "backup-1", date: 0, path: backupArchive }] },
      { path: customInstallation, backups: [] }
    ],
    gameVersions: [{ path: gameVersion }],
    ...overrides
  } as unknown as ConfigType
}

beforeEach(async () => {
  // realpathSync: macOS hands out /var/folders/... temp paths that are a
  // symlink to /private/var/..., which the policy's symlink walk refuses.
  temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "path-policy-")))

  managedFolder = join(temporaryRoot, "Installations")
  versionsFolder = join(temporaryRoot, "Versions")
  backupsFolder = join(temporaryRoot, "Backups")
  userDataFolder = join(temporaryRoot, "userData")
  outsideFolder = join(temporaryRoot, "elsewhere")

  mainInstallation = join(managedFolder, "Main")
  customInstallation = join(outsideFolder, "Custom")
  gameVersion = join(versionsFolder, "1.20.0")
  backupArchive = join(backupsFolder, "Installations", "Main", "Main_2026-01-01.zip")

  fse.ensureDirSync(join(mainInstallation, "Mods"))
  fse.writeFileSync(join(mainInstallation, "clientsettings.json"), "{}")
  fse.writeFileSync(join(mainInstallation, "Mods", "amod.zip"), "")
  fse.ensureDirSync(join(customInstallation, "Mods"))
  fse.ensureDirSync(join(outsideFolder, "Neighbour"))
  fse.ensureDirSync(join(gameVersion, "assets"))
  fse.writeFileSync(join(gameVersion, "Vintagestory.exe"), "")
  fse.ensureDirSync(join(backupsFolder, "Installations", "Main"))
  fse.writeFileSync(backupArchive, "")
  for (const folder of ["Logs", "Cache", "Icons", "Sessions"]) fse.ensureDirSync(join(userDataFolder, folder))

  electronState.userData = userDataFolder
  electronState.appData = join(temporaryRoot, "appData")
  electronState.home = temporaryRoot
  electronState.appPath = join(temporaryRoot, "app")
  fse.ensureDirSync(electronState.appData)
  fse.ensureDirSync(electronState.appPath)
  configState.config = buildConfig()

  // The approval list is module state with a ten minute TTL; a fresh module per
  // test keeps one test's picked folder from authorizing the next one's paths.
  vi.resetModules()
  policy = await import("@src/ipc/pathPolicy")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

async function admits(pathValue: string, options?: Parameters<PathPolicyModule["assertManagedPath"]>[2]): Promise<boolean> {
  try {
    await policy.assertManagedPath(pathValue, "path", options)
    return true
  } catch {
    return false
  }
}

describe("managed path policy: the shapes the launcher legitimately passes", () => {
  it("admits an installation folder, the files inside it, and its game version", async () => {
    assert.equal(await admits(mainInstallation), true)
    assert.equal(await admits(join(mainInstallation, "Mods")), true)
    assert.equal(await admits(join(mainInstallation, "Mods", "amod.zip")), true)
    assert.equal(await admits(join(mainInstallation, "clientsettings.json"), { allowMissing: true }), true)
    assert.equal(await admits(gameVersion), true)
    assert.equal(await admits(join(gameVersion, "Vintagestory.exe")), true)
  })

  it("admits an installation the user put outside every configured folder, and its subtree", async () => {
    assert.equal(await admits(customInstallation), true)
    assert.equal(await admits(join(customInstallation, "Mods")), true)
  })

  it("admits the configured folders, the launcher's own folders, and a download target under them", async () => {
    assert.equal(await admits(managedFolder), true)
    assert.equal(await admits(versionsFolder), true)
    assert.equal(await admits(backupsFolder), true)
    assert.equal(await admits(join(versionsFolder, "1.21.0"), { allowMissing: true }), true)
    assert.equal(await admits(join(userDataFolder, "Icons")), true)
    assert.equal(await admits(join(userDataFolder, "Icons", "icon.png"), { allowMissing: true }), true)
    assert.equal(await admits(join(userDataFolder, "Logs")), true)
    assert.equal(await admits(join(userDataFolder, "Cache")), true)
    assert.equal(await admits(join(userDataFolder, "Sessions")), true)
    assert.equal(await admits(join(userDataFolder, "Sessions", "main.json"), { allowMissing: true }), true)
  })

  it("admits a backup archive itself", async () => {
    assert.equal(await admits(backupArchive), true)
  })

  it("admits the two restore workspaces beside an installation and nothing else beside it", async () => {
    assert.equal(await admits(`${customInstallation}${"-restoring-"}${RESTORE_TOKEN}`, { allowMissing: true }), true)
    assert.equal(await admits(`${customInstallation}${"-replaced-"}${RESTORE_TOKEN}`, { allowMissing: true }), true)
    assert.equal(await admits(`${customInstallation}-restoring-notauuid`, { allowMissing: true }), false)
    assert.equal(await admits(`${customInstallation}-backup`, { allowMissing: true }), false)
  })
})

describe("managed path policy: the boundary around a config entry", () => {
  it("refuses the parent of an installation that sits outside the configured folders", async () => {
    assert.equal(await admits(outsideFolder), false)
    assert.equal(await admits(temporaryRoot), false)
  })

  it("refuses a sibling of an installation", async () => {
    assert.equal(await admits(join(outsideFolder, "Neighbour")), false)
    assert.equal(await admits(join(outsideFolder, "Absent"), { allowMissing: true }), false)
  })

  it("grants a backup archive itself and nothing under it once the backups folder has moved", async () => {
    // An archive stays recorded where it was made, so moving the backups folder
    // leaves the old archives covered by their own config entry and by nothing
    // else. That is the only situation where the entry decides on its own, and
    // it is where reading a `.zip` file as a folder was pure reach.
    const movedFolder = join(temporaryRoot, "NewBackups")
    fse.ensureDirSync(movedFolder)
    configState.config = buildConfig({ backupsFolder: movedFolder })

    assert.equal(await admits(backupArchive), true)
    assert.equal(await admits(join(backupArchive, "payload"), { allowMissing: true }), false)
    assert.equal(await admits(join(backupsFolder, "Installations", "Main", "other.zip"), { allowMissing: true }), false)
  })

  it("keeps an installation nested inside another installation covered by the outer one", async () => {
    const outer = join(outsideFolder, "Outer")
    const nested = join(outer, "profiles", "Nested")
    fse.ensureDirSync(nested)
    configState.config = buildConfig({
      installations: [
        { path: outer, backups: [] },
        { path: nested, backups: [] }
      ] as unknown as ConfigType["installations"]
    })

    // Nesting is the user's own arrangement, and the outer folder is a managed
    // installation in its own right, so its subtree stays reachable. What the
    // nested entry must not do is reach back out of the folder it names.
    assert.equal(await admits(join(outer, "profiles")), true)
    assert.equal(await admits(nested), true)
    assert.equal(await admits(outsideFolder), false)
  })

  it("refuses traversal out of a managed folder", async () => {
    assert.equal(await admits(join(mainInstallation, "..", "..", "escape"), { allowMissing: true }), false)
  })
})

/**
 * The two grades the policy hands out for a path with a link in it (#237).
 *
 * Symlinks are made here rather than mocked because the walk stats real inodes,
 * and Windows is skipped throughout: making one there needs Developer Mode or
 * elevation the CI runners do not have, which #267 tracks. The production code
 * is platform independent, so the Linux and macOS runs are what pin it.
 */
describe.skipIf(process.platform === "win32")("managed path policy: a Mods folder the user linked in", () => {
  let realMods: string
  let linkedMods: string

  beforeEach(() => {
    // The reported shape: the profile's own Mods folder replaced by a link at a
    // Mods folder that lives somewhere else entirely.
    realMods = join(outsideFolder, "VintagestoryData", "Mods")
    fse.ensureDirSync(realMods)
    fse.writeFileSync(join(realMods, "amod.zip"), "")

    linkedMods = join(mainInstallation, "Mods")
    fse.removeSync(linkedMods)
    symlinkSync(realMods, linkedMods, "dir")
  })

  it("refuses the link on the default grade, the one every writing channel asks for", async () => {
    assert.equal(await admits(linkedMods), false)
    assert.equal(await admits(join(linkedMods, "amod.zip")), false)
  })

  it("admits the link on the read grade, so the mod list and the folder button can see it", async () => {
    assert.equal(await admits(linkedMods, { allowSymlinks: true }), true)
    assert.equal(await admits(join(linkedMods, "amod.zip"), { allowSymlinks: true }), true)
  })

  it("keeps the grant check on the read grade, so a link does not buy an unmanaged path", async () => {
    assert.equal(await admits(join(outsideFolder, "Neighbour"), { allowSymlinks: true }), false)
  })

  // The trade the read grade makes, stated out loud: it is lexical, so a link
  // planted inside a granted subtree does reach past the grant for a read. What
  // must not follow is anything that writes. assertManagedDeletionPath only
  // decides, it never removes, so this row cannot touch the system folder.
  it("refuses to delete through a link that escapes into a system folder", async () => {
    const escape = join(mainInstallation, "escape")
    symlinkSync("/etc", escape, "dir")

    assert.equal(await admits(join(escape, "hosts"), { allowSymlinks: true }), true)
    await assert.rejects(() => policy.assertManagedDeletionPath(join(escape, "hosts")), /Symbolic links are not allowed/)
  })

  it("refuses to delete a mod reached through the linked folder", async () => {
    await assert.rejects(() => policy.assertManagedDeletionPath(join(linkedMods, "amod.zip")), /Symbolic links are not allowed/)
  })
})

describe("managed path policy: deletion and protected paths", () => {
  it("refuses to delete the folders the launcher is built around", async () => {
    for (const protectedPath of [
      userDataFolder,
      electronState.appData,
      temporaryRoot,
      electronState.appPath,
      managedFolder,
      versionsFolder,
      backupsFolder,
      join(userDataFolder, "Logs"),
      join(userDataFolder, "Cache"),
      join(userDataFolder, "Icons"),
      join(userDataFolder, "Sessions")
    ]) {
      await assert.rejects(() => policy.assertManagedDeletionPath(protectedPath), /Protected path|Unmanaged/)
    }
  })

  it("refuses to delete a folder that holds a protected folder, another installation or a game version", async () => {
    const outer = join(outsideFolder, "Outer")
    const nested = join(outer, "Nested")
    const nestedVersion = join(outer, "game", "1.21.0")
    fse.ensureDirSync(nested)
    fse.ensureDirSync(nestedVersion)
    configState.config = buildConfig({
      installations: [
        { path: outer, backups: [] },
        { path: nested, backups: [] }
      ] as unknown as ConfigType["installations"],
      gameVersions: [{ path: nestedVersion }] as unknown as ConfigType["gameVersions"]
    })

    await assert.rejects(() => policy.assertManagedDeletionPath(outer), /holds a managed folder/)
    await assert.rejects(() => policy.assertManagedDeletionPath(join(outer, "game")), /holds a managed folder/)
    // The inner entries themselves, and anything that holds nothing managed, still go.
    assert.equal(await policy.assertManagedDeletionPath(nested), nested)
    assert.equal(await policy.assertManagedDeletionPath(nestedVersion), nestedVersion)

    // The Backups, Versions and Installations folders, moved inside an installation.
    for (const folder of ["backupsFolder", "defaultVersionsFolder", "defaultInstallationsFolder"] as const) {
      configState.config = buildConfig({ [folder]: join(mainInstallation, "inside") })
      fse.ensureDirSync(join(mainInstallation, "inside"))
      await assert.rejects(() => policy.assertManagedDeletionPath(mainInstallation), /holds a managed folder/, folder)
    }
  })

  /**
   * #707: the VS Versions list works out in the renderer whether a version's folder can be deleted,
   * and offers "Remove from List" when it cannot. If it said yes where the host says no, the version
   * would fail on every retry with the generic uninstall error, with nothing left to click.
   */
  it("refuses exactly the version folders the VS Versions list keeps", async () => {
    const folder = join(outsideFolder, "Games")
    const inside = join(folder, "Inside")
    fse.ensureDirSync(inside)
    const installation = (path: string): Partial<ConfigType> => ({ installations: [{ id: "i", path, backups: [] }] as unknown as ConfigType["installations"] })
    const versions = (...paths: string[]): Partial<ConfigType> => ({ gameVersions: paths.map((path, index) => ({ id: `v${index}`, path })) as unknown as ConfigType["gameVersions"] })
    const scenarios: Array<[string, Partial<ConfigType>, boolean]> = [
      ["alone", versions(folder), false],
      ["an Installation next to it", { ...versions(folder), ...installation(join(outsideFolder, "Sibling")) }, false],
      ["an Installation inside", { ...versions(folder), ...installation(inside) }, true],
      ["an Installation on the same folder", { ...versions(folder), ...installation(folder) }, true],
      ["another VS Version inside", versions(folder, inside), true],
      ["another VS Version on the same folder", versions(folder, folder), true],
      ["the Installations folder inside", { ...versions(folder), defaultInstallationsFolder: inside }, true],
      ["the VS Versions folder inside", { ...versions(folder), defaultVersionsFolder: inside }, true],
      ["the Backups folder inside", { ...versions(folder), backupsFolder: inside }, true],
      ["the VS Versions folder itself", { ...versions(folder), defaultVersionsFolder: folder }, true]
    ]

    for (const [label, overrides, expectedKept] of scenarios) {
      const config = buildConfig(overrides)
      configState.config = config
      policy.registerUserSelectedPaths([folder])

      const refused = await policy.assertManagedDeletionPath(folder).then(
        () => false,
        () => true
      )
      const held = findHeldManagedFolder(
        { id: "v0", path: folder },
        { settings: config, installations: config.installations, gameVersions: config.gameVersions.filter((gameVersion) => (gameVersion as { id?: string }).id !== "v0") },
        toFolderPlatform(process.platform)
      )

      assert.equal(refused, expectedKept, `${label}: policy`)
      assert.equal(held !== null, expectedKept, `${label}: list`)
    }
  })

  /**
   * #733: a recorded archive is a managed file like any folder above, so a wipe of a folder that
   * holds one is refused, by the host and by the pre-check the Installations and Backups pages run
   * first. Both read the same records, so they answer alike.
   */
  it("refuses exactly the folders that hold a recorded backup archive, in the host and in the pre-check", async () => {
    const folder = join(outsideFolder, "Holder")
    const sibling = join(outsideFolder, "Sibling")
    for (const dir of [join(folder, "old", "Installations"), sibling]) fse.ensureDirSync(dir)
    const archiveInside = join(folder, "old", "Installations", "Other_1.tar.gz")
    const archiveBeside = join(sibling, "Other_1.tar.gz")
    fse.writeFileSync(archiveInside, "")
    fse.writeFileSync(archiveBeside, "")
    const record = (name: string, path: string): object => ({ id: name, date: 0, path, worldName: "w" })
    const scenarios: Array<[string, object, boolean]> = [
      ["a backup of another Installation inside", { backups: [record("a", archiveInside)] }, true],
      ["a world backup of another Installation inside", { worldBackups: [record("a", archiveInside)] }, true],
      ["an archive next to it", { backups: [record("a", archiveBeside)] }, false],
      ["no archive at all", {}, false]
    ]

    for (const [label, otherRecords, expectedHeld] of scenarios) {
      const config = buildConfig({
        installations: [
          { id: "holder", path: folder, backups: [] },
          { id: "other", path: customInstallation, backups: [], worldBackups: [], ...otherRecords }
        ] as unknown as ConfigType["installations"]
      })
      configState.config = config

      const refused = await policy.assertManagedDeletionPath(folder).then(
        () => false,
        () => true
      )
      const held = findHeldManagedFolder(
        { id: "holder", path: folder },
        { settings: config, installations: config.installations, gameVersions: config.gameVersions },
        toFolderPlatform(process.platform)
      )

      assert.equal(refused, expectedHeld, `${label}: policy`)
      assert.equal(held !== null, expectedHeld, `${label}: pre-check`)
      if (expectedHeld) assert.equal(held, archiveInside, `${label}: names the archive`)
    }
  })

  it("counts the Installation's own archives, and still deletes a listed archive itself", async () => {
    const own = join(mainInstallation, "Backups", "Main_2.tar.gz")
    fse.ensureDirSync(join(mainInstallation, "Backups"))
    fse.writeFileSync(own, "")
    configState.config = buildConfig({
      installations: [
        { id: "main", path: mainInstallation, backups: [{ id: "b", date: 0, path: backupArchive }], worldBackups: [{ id: "w", date: 0, path: own, worldName: "w" }] }
      ] as unknown as ConfigType["installations"]
    })

    await assert.rejects(() => policy.assertManagedDeletionPath(mainInstallation), /holds a managed folder/)
    const config = configState.config as ConfigType
    assert.equal(findHeldManagedFolder({ id: "main", path: mainInstallation }, { settings: config, installations: config.installations, gameVersions: [] }, toFolderPlatform(process.platform)), own)
    assert.equal(await policy.assertManagedDeletionPath(own), own)
    assert.equal(await policy.assertManagedDeletionPath(backupArchive), backupArchive)
  })

  /**
   * #733, round four: a delete with data takes the Installation's own backups and world backups
   * and their records with it, so they are not what its folder holds. A restore keeps the records
   * and wipes the folder, so its own archives still count. Another Installation's archive counts
   * in both. The host and the pre-check say the same in each mode.
   */
  it("does not count the Installation's own archives for a delete, still counts them for a restore, and always counts another one's", async () => {
    const ownBackup = join(mainInstallation, "Backups", "Installations", "Main", "Main_1.tar.gz")
    const ownWorld = join(mainInstallation, "Backups", "Worlds", "0f8fad5b-d9cb-469f-a165-70867728950e.tar.gz")
    const otherArchive = join(mainInstallation, "Backups", "Installations", "Custom", "Custom_1.tar.gz")
    for (const file of [ownBackup, ownWorld, otherArchive]) {
      fse.ensureDirSync(join(file, ".."))
      fse.writeFileSync(file, "")
    }
    const build = (otherRecords: object): ConfigType =>
      buildConfig({
        installations: [
          { id: "main", name: "Main", path: mainInstallation, backups: [{ id: "b", date: 0, path: ownBackup }], worldBackups: [{ id: "w", date: 0, path: ownWorld, worldName: "w" }] },
          { id: "custom", name: "Custom", path: customInstallation, backups: [], ...otherRecords }
        ] as unknown as ConfigType["installations"]
      })
    const preCheck = (config: ConfigType, ignoreOwnArchives: boolean): string | null =>
      findHeldManagedFolder({ id: "main", path: mainInstallation }, { settings: config, installations: config.installations, gameVersions: [] }, toFolderPlatform(process.platform), {
        ignoreOwnArchives
      })

    configState.config = build({})
    const rejected = (ownArchivesLeave: boolean): Promise<boolean> =>
      policy.assertManagedDeletionPath(mainInstallation, { ownArchivesLeave }).then(
        () => false,
        () => true
      )
    assert.equal(await rejected(false), true, "restore: host counts them")
    assert.equal(preCheck(configState.config as ConfigType, false), ownBackup, "restore: pre-check counts them")
    assert.equal(await rejected(true), false, "delete: host lets them go")
    assert.equal(preCheck(configState.config as ConfigType, true), null, "delete: pre-check lets them go")

    configState.config = build({ backups: [{ id: "c", date: 0, path: otherArchive }] })
    assert.equal(await rejected(true), true, "delete: host still counts another Installation's archive")
    assert.equal(preCheck(configState.config as ConfigType, true), otherArchive, "delete: pre-check still counts another Installation's archive")
  })

  it("does not let the exemption reach the archives of an Installation whose folder is not the path", async () => {
    const holder = join(outsideFolder, "Holder")
    const archiveOfCustom = join(holder, "Custom_1.tar.gz")
    fse.ensureDirSync(holder)
    fse.writeFileSync(archiveOfCustom, "")
    configState.config = buildConfig({
      installations: [{ id: "custom", name: "Custom", path: customInstallation, backups: [{ id: "c", date: 0, path: archiveOfCustom }] }] as unknown as ConfigType["installations"]
    })

    policy.registerUserSelectedPaths([holder])

    await assert.rejects(() => policy.assertManagedDeletionPath(holder, { ownArchivesLeave: true }), /holds a managed folder/)
  })

  /**
   * #733, round four: the order a player deals with what the folder holds. The Config folders first,
   * then every listed archive, then the other Installations and the VS Versions: removing an
   * Installation's entry makes the launcher forget its archives, so none may be listed when that happens.
   */
  it("reports the Config folders, then the listed archives, then the other Installations, then the VS Versions", async () => {
    const holder = join(outsideFolder, "Holder")
    const inside = (...parts: string[]): string => join(holder, ...parts)
    const archiveOfModded = inside("Installations", "Modded", "Backups", "Modded_1.tar.gz")
    const config = buildConfig({
      backupsFolder: inside("Backups"),
      installations: [
        { id: "holder", name: "Holder", path: holder, backups: [] },
        { id: "modded", name: "Modded", path: inside("Installations", "Modded"), backups: [{ id: "m", date: 0, path: archiveOfModded }] }
      ] as unknown as ConfigType["installations"],
      gameVersions: [{ id: "v", path: inside("Versions", "1.21.0") }] as unknown as ConfigType["gameVersions"]
    })
    const heldBy = (overrides: Partial<ConfigType>): string | null => {
      const merged = { ...config, ...overrides }
      return findHeldManagedFolder({ id: "holder", path: holder }, { settings: merged, installations: merged.installations, gameVersions: merged.gameVersions }, toFolderPlatform(process.platform))
    }
    const withoutArchive = (): ConfigType["installations"] => config.installations.map((entry) => ({ ...entry, backups: [] }))

    assert.equal(heldBy({}), inside("Backups"), "the Config folder first")
    assert.equal(heldBy({ backupsFolder: backupsFolder }), archiveOfModded, "then the listed archive, ahead of the Installation that owns it and of the VS Version")
    assert.equal(heldBy({ backupsFolder, installations: withoutArchive() }), inside("Installations", "Modded"), "then the other Installation")
    assert.equal(heldBy({ backupsFolder, installations: withoutArchive().slice(0, 1) }), inside("Versions", "1.21.0"), "then the VS Version")
    assert.equal(heldBy({ backupsFolder, installations: withoutArchive().slice(0, 1), gameVersions: [] }), null)
  })

  // A VS Version on the Installation's own folder cannot be moved out by hand, so it is its own kind, linked or not.
  it("tells a VS Version on the Installation's own folder from one inside it", () => {
    const holder = { id: "holder", path: join(outsideFolder, "Holder") }
    const describe = (gameVersions: object[]): unknown =>
      describeHeldFolder(
        holder,
        { settings: buildConfig({}), installations: [{ ...holder, name: "Holder" }], gameVersions: gameVersions as ConfigType["gameVersions"] },
        toFolderPlatform(process.platform)
      )
    const version = (path: string, linked: boolean): object => ({ label: "1.21.0", path, linked })

    for (const linked of [false, true]) {
      assert.deepEqual(describe([version(holder.path, linked)]), { path: holder.path, kind: "sameFolderVersion", name: "1.21.0" })
      assert.deepEqual(describe([version(join(holder.path, "game"), linked)]), { path: join(holder.path, "game"), kind: linked ? "linkedVersion" : "version" })
    }
  })

  it("deletes an installation, a game version and a backup archive", async () => {
    assert.equal(await policy.assertManagedDeletionPath(mainInstallation), mainInstallation)
    assert.equal(await policy.assertManagedDeletionPath(gameVersion), gameVersion)
    assert.equal(await policy.assertManagedDeletionPath(backupArchive), backupArchive)
  })
})

describe("managed path policy: paths the user picked in a native dialog", () => {
  it("authorizes a picked file for itself, and for nothing around it", async () => {
    const picked = join(outsideFolder, "modpack.json")
    fse.writeFileSync(picked, "{}")
    fse.writeFileSync(join(outsideFolder, "other.json"), "{}")

    policy.registerUserSelectedPaths([picked])

    assert.equal(policy.isUserApprovedPath(picked), true)
    assert.equal(await admits(picked), true)
    assert.equal(policy.isUserApprovedPath(join(outsideFolder, "other.json")), false)
    assert.equal(policy.isUserApprovedPath(outsideFolder), false)
  })

  it("authorizes a file the save dialog named but that does not exist yet", async () => {
    const target = join(outsideFolder, "export.json")
    policy.registerUserSelectedPaths([target])

    assert.equal(await admits(target, { allowMissing: true }), true)
  })

  it("authorizes a picked folder together with its subtree", async () => {
    const picked = join(outsideFolder, "Picked")
    fse.ensureDirSync(join(picked, "inner"))

    policy.registerUserSelectedPaths([picked])

    assert.equal(await admits(picked), true)
    assert.equal(await admits(join(picked, "inner")), true)
    assert.equal(await admits(outsideFolder), false)
  })

  it("ignores approvals when the caller asks for configured paths only", async () => {
    policy.registerUserSelectedPaths([outsideFolder])

    assert.equal(await admits(outsideFolder), true)
    assert.equal(await admits(outsideFolder, { allowApprovedSelection: false }), false)
  })
})

describe("config path authorization", () => {
  async function authorizes(next: Partial<ConfigType>): Promise<boolean> {
    return policy.assertConfigPathsAuthorized(buildConfig(next), buildConfig())
  }

  it("accepts a config that leaves every path where it already is", async () => {
    assert.equal(await authorizes({}), true)
  })

  it("accepts a new installation or game version inside a configured folder", async () => {
    assert.equal(await authorizes({ installations: [{ path: join(managedFolder, "Second"), backups: [] }] as unknown as ConfigType["installations"] }), true)
    assert.equal(await authorizes({ gameVersions: [{ path: join(versionsFolder, "1.21.0") }] as unknown as ConfigType["gameVersions"] }), true)
  })

  it("keeps archives made before the backups folder moved", async () => {
    const movedFolder = join(temporaryRoot, "NewBackups")
    fse.ensureDirSync(movedFolder)

    // Second save after the move: the current config already points at the new
    // folder, so the old archives are authorized by their own recorded paths.
    const currentConfig = buildConfig({ backupsFolder: movedFolder })
    const nextConfig = buildConfig({ backupsFolder: movedFolder })

    assert.equal(await policy.assertConfigPathsAuthorized(nextConfig, currentConfig), true)
  })

  it("refuses an installation declared inside the launcher's own folders", async () => {
    assert.equal(await authorizes({ installations: [{ path: join(userDataFolder, "Cache", "Images"), backups: [] }] as unknown as ConfigType["installations"] }), false)
    assert.equal(await authorizes({ installations: [{ path: join(userDataFolder, "Logs"), backups: [] }] as unknown as ConfigType["installations"] }), false)
    assert.equal(await authorizes({ backupsFolder: join(userDataFolder, "Icons") }), false)
    assert.equal(await authorizes({ installations: [{ path: join(userDataFolder, "Sessions"), backups: [] }] as unknown as ConfigType["installations"] }), false)
  })

  it("refuses an installation declared under a backup archive", async () => {
    const movedFolder = join(temporaryRoot, "NewBackups")
    fse.ensureDirSync(movedFolder)
    const currentConfig = buildConfig({ backupsFolder: movedFolder })
    const nextConfig = buildConfig({
      backupsFolder: movedFolder,
      installations: [{ path: join(backupArchive, "unpacked"), backups: [] }] as unknown as ConfigType["installations"]
    })

    assert.equal(await policy.assertConfigPathsAuthorized(nextConfig, currentConfig), false)
  })

  it("refuses a path nobody picked and no folder covers", async () => {
    assert.equal(await authorizes({ installations: [{ path: join(outsideFolder, "Unpicked"), backups: [] }] as unknown as ConfigType["installations"] }), false)
    assert.equal(await authorizes({ installations: [{ path: outsideFolder, backups: [] }] as unknown as ConfigType["installations"] }), false)
  })

  it("accepts a folder the user just picked in a dialog", async () => {
    const picked = join(outsideFolder, "Picked")
    fse.ensureDirSync(picked)
    policy.registerUserSelectedPaths([picked])

    assert.equal(await authorizes({ installations: [{ path: join(picked, "Install"), backups: [] }] as unknown as ConfigType["installations"] }), true)
  })
})
