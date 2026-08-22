/**
 * configReducer against every action it knows, table-driven, plus the edge
 * arms each one has: an id that names nothing in state, a boundary value, an
 * action that has to leave sibling entries referentially untouched, and the
 * `_notifiedModUpdatesInstallations` bookkeeping ADD_NOTIFIED_MOD_UPDATE
 * carries but normalizeConfig (src/config/configManager.ts) never writes back
 * out.
 *
 * configReducer.ts is a plain function with no React or DOM dependency, so
 * this is a node test rather than one under tests/renderer-dom, the same way
 * tests/renderer/configSaveHealth.test.ts already is for this feature.
 */
import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { CONFIG_ACTIONS, configReducer, initialState, type ConfigAction } from "../../src/renderer/src/features/config/contexts/configReducer"

function baseConfig(overrides: Partial<ConfigType> = {}): ConfigType {
  return {
    schemaVersion: 2,
    lastUsedInstallation: null,
    defaultInstallationsFolder: "/installs",
    defaultVersionsFolder: "/versions",
    backupsFolder: "/backups",
    window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
    account: null,
    installations: [],
    gameVersions: [],
    favMods: [],
    suspendedModUpdates: [],
    customIcons: [],
    ...overrides
  }
}

function installation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-1",
    name: "Install 1",
    icon: "",
    path: "/installs/install-1",
    version: "1.20.0",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 4,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    ...overrides
  }
}

function backup(overrides: Partial<BackupType> = {}): BackupType {
  return { id: "backup-1", date: 1000, path: "/backups/backup-1.zip", ...overrides }
}

function gameVersion(overrides: Partial<GameVersionType> = {}): GameVersionType {
  return { version: "1.20.0", path: "/versions/1.20.0", ...overrides }
}

function icon(overrides: Partial<IconType> = {}): IconType {
  return { id: "icon-1", name: "Icon 1", icon: "icon-1.png", custom: true, ...overrides }
}

describe("configReducer: initialState", () => {
  it("is the sentinel schemaVersion 0, never a real schema", () => {
    assert.equal(initialState.schemaVersion, 0)
    assert.deepEqual(initialState.installations, [])
  })
})

describe("configReducer: SET_CONFIG", () => {
  it("replaces the whole state with the payload", () => {
    const payload = baseConfig({ schemaVersion: 5 })
    const result = configReducer(initialState, { type: CONFIG_ACTIONS.SET_CONFIG, payload })
    assert.equal(result, payload)
  })
})

describe("configReducer: scalar setters", () => {
  it("SET_LAST_USED_INSTALLATION accepts an id and null alike", () => {
    const config = baseConfig()
    const withId = configReducer(config, { type: CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION, payload: "install-1" })
    assert.equal(withId.lastUsedInstallation, "install-1")

    const backToNull = configReducer(withId, { type: CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION, payload: null })
    assert.equal(backToNull.lastUsedInstallation, null)
  })

  it("SET_DEFAULT_INSTALLATIONS_FOLDER overwrites defaultInstallationsFolder only", () => {
    const config = baseConfig()
    const result = configReducer(config, { type: CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER, payload: "/new-installs" })
    assert.equal(result.defaultInstallationsFolder, "/new-installs")
    assert.equal(result.defaultVersionsFolder, config.defaultVersionsFolder)
  })

  it("SET_DEFAULT_VERSIONS_FOLDER overwrites defaultVersionsFolder only", () => {
    const config = baseConfig()
    const result = configReducer(config, { type: CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER, payload: "/new-versions" })
    assert.equal(result.defaultVersionsFolder, "/new-versions")
  })

  it("SET_DEFAULT_BACKUPS_FOLDER overwrites backupsFolder only", () => {
    const config = baseConfig()
    const result = configReducer(config, { type: CONFIG_ACTIONS.SET_DEFAULT_BACKUPS_FOLDER, payload: "/new-backups" })
    assert.equal(result.backupsFolder, "/new-backups")
  })

  it("SET_ACCOUNT accepts an account and null alike", () => {
    const config = baseConfig()
    const account: AccountType = { email: "a@b.c", playerName: "A", playerUid: "1", playerEntitlements: null, hostGameServer: false }
    const withAccount = configReducer(config, { type: CONFIG_ACTIONS.SET_ACCOUNT, payload: account })
    assert.deepEqual(withAccount.account, account)

    const loggedOut = configReducer(withAccount, { type: CONFIG_ACTIONS.SET_ACCOUNT, payload: null })
    assert.equal(loggedOut.account, null)
  })
})

describe("configReducer: installations", () => {
  it("ADD_INSTALLATION prepends, most recent first", () => {
    const existing = installation({ id: "existing" })
    const config = baseConfig({ installations: [existing] })
    const added = installation({ id: "new" })

    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_INSTALLATION, payload: added })
    assert.deepEqual(
      result.installations.map((i) => i.id),
      ["new", "existing"]
    )
  })

  it("DELETE_INSTALLATION removes the matching id and leaves the rest untouched", () => {
    const keep = installation({ id: "keep" })
    const remove = installation({ id: "remove" })
    const config = baseConfig({ installations: [keep, remove] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.DELETE_INSTALLATION, payload: { id: "remove" } })
    assert.deepEqual(result.installations, [keep])
  })

  it("DELETE_INSTALLATION on an id naming nothing leaves every installation as it was", () => {
    const config = baseConfig({ installations: [installation()] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.DELETE_INSTALLATION, payload: { id: "no-such-id" } })
    assert.deepEqual(result.installations, config.installations)
    assert.notEqual(result.installations, config.installations, "still a new array, even when nothing was removed")
  })

  it("EDIT_INSTALLATION merges updates onto the matching installation only", () => {
    const target = installation({ id: "target", name: "Old name" })
    const other = installation({ id: "other", name: "Other" })
    const config = baseConfig({ installations: [target, other] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: "target", updates: { name: "New name" } } })
    assert.equal(result.installations.find((i) => i.id === "target")!.name, "New name")
    assert.equal(
      result.installations.find((i) => i.id === "other"),
      other,
      "untouched installation stays referentially the same"
    )
  })

  it("EDIT_INSTALLATION on an id naming nothing changes nothing", () => {
    const config = baseConfig({ installations: [installation()] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: "missing", updates: { name: "X" } } })
    assert.deepEqual(result.installations, config.installations)
  })

  it("MOVE_INSTALLATION up swaps a middle installation with the one above it", () => {
    const config = baseConfig({ installations: [installation({ id: "a" }), installation({ id: "b" }), installation({ id: "c" })] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.MOVE_INSTALLATION, payload: { id: "b", direction: "up" } })
    assert.deepEqual(
      result.installations.map((i) => i.id),
      ["b", "a", "c"]
    )
  })

  it("MOVE_INSTALLATION down swaps a middle installation with the one below it", () => {
    const config = baseConfig({ installations: [installation({ id: "a" }), installation({ id: "b" }), installation({ id: "c" })] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.MOVE_INSTALLATION, payload: { id: "b", direction: "down" } })
    assert.deepEqual(
      result.installations.map((i) => i.id),
      ["a", "c", "b"]
    )
  })

  it("MOVE_INSTALLATION moves the entries themselves, not copies of them", () => {
    const first = installation({ id: "a" })
    const second = installation({ id: "b" })
    const config = baseConfig({ installations: [first, second] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.MOVE_INSTALLATION, payload: { id: "b", direction: "up" } })
    assert.equal(result.installations[0], second)
    assert.equal(result.installations[1], first)
  })

  it("MOVE_INSTALLATION up on the first installation is a no-op, same state object back", () => {
    const config = baseConfig({ installations: [installation({ id: "a" }), installation({ id: "b" })] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.MOVE_INSTALLATION, payload: { id: "a", direction: "up" } })
    assert.equal(result, config, "nothing moved, so nothing downstream should see new state")
  })

  it("MOVE_INSTALLATION down on the last installation is a no-op, same state object back", () => {
    const config = baseConfig({ installations: [installation({ id: "a" }), installation({ id: "b" })] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.MOVE_INSTALLATION, payload: { id: "b", direction: "down" } })
    assert.equal(result, config)
  })

  it("MOVE_INSTALLATION on an id naming nothing leaves the order untouched", () => {
    const config = baseConfig({ installations: [installation({ id: "a" }), installation({ id: "b" })] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.MOVE_INSTALLATION, payload: { id: "missing", direction: "up" } })
    assert.equal(result, config)
    assert.deepEqual(
      result.installations.map((i) => i.id),
      ["a", "b"]
    )
  })

  it("ADD_INSTALLATION_BACKUP prepends a backup onto the matching installation only", () => {
    const target = installation({ id: "target", backups: [] })
    const other = installation({ id: "other", backups: [backup({ id: "existing" })] })
    const config = baseConfig({ installations: [target, other] })
    const newBackup = backup({ id: "new-backup" })

    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_INSTALLATION_BACKUP, payload: { id: "target", backup: newBackup } })
    assert.deepEqual(
      result.installations.find((i) => i.id === "target")!.backups.map((b) => b.id),
      ["new-backup"]
    )
    assert.equal(
      result.installations.find((i) => i.id === "other"),
      other
    )
  })

  it("ADD_INSTALLATION_BACKUP on an id naming nothing changes nothing", () => {
    const config = baseConfig({ installations: [installation({ backups: [] })] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_INSTALLATION_BACKUP, payload: { id: "missing", backup: backup() } })
    assert.deepEqual(result.installations[0]!.backups, [])
  })

  it("DELETE_INSTALLATION_BACKUP removes the matching backup from the matching installation", () => {
    const keep = backup({ id: "keep" })
    const remove = backup({ id: "remove" })
    const target = installation({ id: "target", backups: [keep, remove] })
    const config = baseConfig({ installations: [target] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.DELETE_INSTALLATION_BACKUP, payload: { id: "target", backupId: "remove" } })
    assert.deepEqual(result.installations[0]!.backups, [keep])
  })

  it("DELETE_INSTALLATION_BACKUP on an installation id naming nothing changes nothing", () => {
    const target = installation({ id: "target", backups: [backup()] })
    const config = baseConfig({ installations: [target] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.DELETE_INSTALLATION_BACKUP, payload: { id: "missing", backupId: "backup-1" } })
    assert.deepEqual(result.installations[0]!.backups, target.backups)
  })

  it("DELETE_INSTALLATION_BACKUP on a backup id naming nothing leaves the installation's backups as they were", () => {
    const target = installation({ id: "target", backups: [backup()] })
    const config = baseConfig({ installations: [target] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.DELETE_INSTALLATION_BACKUP, payload: { id: "target", backupId: "no-such-backup" } })
    assert.deepEqual(result.installations[0]!.backups, target.backups)
  })

  it("EDIT_INSTALLATION_BACKUP merges updates onto the matching backup of the matching installation", () => {
    const target = installation({ id: "target", backups: [backup({ id: "b1", date: 1 }), backup({ id: "b2", date: 2 })] })
    const config = baseConfig({ installations: [target] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.EDIT_INSTALLATION_BACKUP, payload: { id: "target", backupId: "b1", updates: { date: 99 } } })
    assert.equal(result.installations[0]!.backups.find((b) => b.id === "b1")!.date, 99)
    assert.equal(result.installations[0]!.backups.find((b) => b.id === "b2")!.date, 2)
  })

  it("EDIT_INSTALLATION_BACKUP on an installation id naming nothing changes nothing", () => {
    const target = installation({ id: "target", backups: [backup({ id: "b1", date: 1 })] })
    const config = baseConfig({ installations: [target] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.EDIT_INSTALLATION_BACKUP, payload: { id: "missing", backupId: "b1", updates: { date: 99 } } })
    assert.equal(result.installations[0]!.backups[0]!.date, 1)
  })

  it("EDIT_INSTALLATION_BACKUP on a backup id naming nothing changes nothing", () => {
    const target = installation({ id: "target", backups: [backup({ id: "b1", date: 1 })] })
    const config = baseConfig({ installations: [target] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.EDIT_INSTALLATION_BACKUP, payload: { id: "target", backupId: "missing", updates: { date: 99 } } })
    assert.equal(result.installations[0]!.backups[0]!.date, 1)
  })
})

describe("configReducer: game versions", () => {
  it("ADD_GAME_VERSION prepends, most recent first", () => {
    const existing = gameVersion({ version: "1.19.0" })
    const config = baseConfig({ gameVersions: [existing] })
    const added = gameVersion({ version: "1.20.0" })

    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_GAME_VERSION, payload: added })
    assert.deepEqual(
      result.gameVersions.map((g) => g.version),
      ["1.20.0", "1.19.0"]
    )
  })

  it("DELETE_GAME_VERSION removes the matching version and leaves the rest untouched", () => {
    const keep = gameVersion({ version: "1.19.0" })
    const remove = gameVersion({ version: "1.20.0" })
    const config = baseConfig({ gameVersions: [keep, remove] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.DELETE_GAME_VERSION, payload: { version: "1.20.0" } })
    assert.deepEqual(result.gameVersions, [keep])
  })

  it("DELETE_GAME_VERSION on a version naming nothing leaves every entry as it was", () => {
    const config = baseConfig({ gameVersions: [gameVersion()] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.DELETE_GAME_VERSION, payload: { version: "9.9.9" } })
    assert.deepEqual(result.gameVersions, config.gameVersions)
  })

  it("EDIT_GAME_VERSION merges updates onto the matching version only", () => {
    const target = gameVersion({ version: "1.20.0", path: "/old" })
    const other = gameVersion({ version: "1.19.0", path: "/other" })
    const config = baseConfig({ gameVersions: [target, other] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: "1.20.0", updates: { path: "/new" } } })
    assert.equal(result.gameVersions.find((g) => g.version === "1.20.0")!.path, "/new")
    assert.equal(
      result.gameVersions.find((g) => g.version === "1.19.0"),
      other
    )
  })

  it("EDIT_GAME_VERSION on a version naming nothing changes nothing", () => {
    const config = baseConfig({ gameVersions: [gameVersion()] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: "9.9.9", updates: { path: "/new" } } })
    assert.deepEqual(result.gameVersions, config.gameVersions)
  })
})

describe("configReducer: custom icons", () => {
  it("ADD_CUSTOM_ICON appends", () => {
    const existing = icon({ id: "existing" })
    const config = baseConfig({ customIcons: [existing] })
    const added = icon({ id: "new" })

    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_CUSTOM_ICON, payload: added })
    assert.deepEqual(
      result.customIcons.map((i) => i.id),
      ["existing", "new"]
    )
  })

  it("DELETE_CUSTOM_ICON removes the matching id and leaves the rest untouched", () => {
    const keep = icon({ id: "keep" })
    const remove = icon({ id: "remove" })
    const config = baseConfig({ customIcons: [keep, remove] })

    const result = configReducer(config, { type: CONFIG_ACTIONS.DELETE_CUSTOM_ICON, payload: { id: "remove" } })
    assert.deepEqual(result.customIcons, [keep])
  })

  it("DELETE_CUSTOM_ICON on an id naming nothing leaves every icon as it was", () => {
    const config = baseConfig({ customIcons: [icon()] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.DELETE_CUSTOM_ICON, payload: { id: "no-such-id" } })
    assert.deepEqual(result.customIcons, config.customIcons)
  })
})

describe("configReducer: favourite mods", () => {
  it("ADD_FAV_MOD appends the modid", () => {
    const config = baseConfig({ favMods: [1, 2] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_FAV_MOD, payload: { modid: 3 } })
    assert.deepEqual(result.favMods, [1, 2, 3])
  })

  it("ADD_FAV_MOD does not dedupe: the reducer itself is not the place that decides that", () => {
    const config = baseConfig({ favMods: [1] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_FAV_MOD, payload: { modid: 1 } })
    assert.deepEqual(result.favMods, [1, 1])
  })

  it("REMOVE_FAV_MOD removes every occurrence of the modid", () => {
    const config = baseConfig({ favMods: [1, 2, 1, 3] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.REMOVE_FAV_MOD, payload: { modid: 1 } })
    assert.deepEqual(result.favMods, [2, 3])
  })

  it("REMOVE_FAV_MOD on a modid naming nothing leaves favMods as it was", () => {
    const config = baseConfig({ favMods: [1, 2] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.REMOVE_FAV_MOD, payload: { modid: 999 } })
    assert.deepEqual(result.favMods, [1, 2])
  })
})

describe("configReducer: suspended mod updates", () => {
  it("ADD_SUSPENDED_MOD_UPDATE appends the modid", () => {
    const config = baseConfig({ suspendedModUpdates: ["alpha"] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_SUSPENDED_MOD_UPDATE, payload: { modid: "beta" } })
    assert.deepEqual(result.suspendedModUpdates, ["alpha", "beta"])
  })

  it("REMOVE_SUSPENDED_MOD_UPDATE removes every occurrence of the modid", () => {
    const config = baseConfig({ suspendedModUpdates: ["alpha", "beta", "alpha"] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.REMOVE_SUSPENDED_MOD_UPDATE, payload: { modid: "alpha" } })
    assert.deepEqual(result.suspendedModUpdates, ["beta"])
  })

  it("REMOVE_SUSPENDED_MOD_UPDATE on a modid naming nothing leaves the list as it was", () => {
    const config = baseConfig({ suspendedModUpdates: ["alpha"] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.REMOVE_SUSPENDED_MOD_UPDATE, payload: { modid: "gamma" } })
    assert.deepEqual(result.suspendedModUpdates, ["alpha"])
  })

  it("leaves the other slices referentially untouched", () => {
    const config = baseConfig({ installations: [installation()] })
    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_SUSPENDED_MOD_UPDATE, payload: { modid: "alpha" } })
    assert.equal(result.installations, config.installations)
    assert.equal(result.favMods, config.favMods)
  })
})

describe("configReducer: ADD_NOTIFIED_MOD_UPDATE", () => {
  it("starts the list when none exists yet", () => {
    const config = baseConfig()
    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_NOTIFIED_MOD_UPDATE, payload: { installationId: "a" } })
    assert.deepEqual(result._notifiedModUpdatesInstallations, ["a"])
  })

  it("appends a second, distinct installation id", () => {
    const config = { ...baseConfig(), _notifiedModUpdatesInstallations: ["a"] }
    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_NOTIFIED_MOD_UPDATE, payload: { installationId: "b" } })
    assert.deepEqual(result._notifiedModUpdatesInstallations, ["a", "b"])
  })

  it("returns the SAME state object, not a copy, when the id was already recorded", () => {
    const config = { ...baseConfig(), _notifiedModUpdatesInstallations: ["a"] }
    const result = configReducer(config, { type: CONFIG_ACTIONS.ADD_NOTIFIED_MOD_UPDATE, payload: { installationId: "a" } })
    assert.equal(result, config, "a no-op dispatch has to stay a no-op, or every consumer of this state re-renders for nothing")
  })
})

describe("configReducer: unknown action", () => {
  it("returns the state unchanged", () => {
    const config = baseConfig()
    const result = configReducer(config, { type: "NOT_A_REAL_ACTION" } as unknown as ConfigAction)
    assert.equal(result, config)
  })
})
