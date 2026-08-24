import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import "./helpers/electronMock"
import { setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"
import { DEFAULT_COMPRESSION_LEVEL } from "@domain/config/defaults"

/**
 * src/config/configManager.ts against a mocked electron (see
 * ./helpers/electronMock, the same one tests/ipc/configHandlers.test.ts
 * uses), exercised directly rather than through the IPC handlers: this file's
 * job is the arms the branch-coverage campaign that added
 * configHandlers.test.ts left standing, not GET_CONFIG/SAVE_CONFIG's own
 * refusal shapes, which that file already covers.
 *
 * `@src/ipc/accountStore` is mocked directly (not electron's `safeStorage`)
 * for the same reason tests/ipc/gameHandlers.test.ts already does: real
 * secure storage does not exist in a test process, and this is the narrow
 * port configManager.ts actually calls.
 *
 * configManager.ts keeps process-wide module state (configPath, configReady,
 * configCache), so every test gets a fresh copy: `vi.resetModules()` in
 * beforeEach, a fresh temp userData/appData folder, then a fresh dynamic
 * import. The module also reads `app.getPath("appData")` at import time (for
 * its default config), which is why the paths have to be set before the
 * import, not after.
 */
vi.mock("@src/ipc/accountStore", () => ({
  saveAccountSecrets: vi.fn(async () => undefined)
}))

import { saveAccountSecrets } from "@src/ipc/accountStore"
import { CUSTOM_BACKGROUND_ID, DEFAULT_BACKGROUND_ID } from "@domain/backgrounds"
import { DEFAULT_MODDB_VISIBILITY_ANSWER, MODDB_VISIBILITY_ACCEPTED, MODDB_VISIBILITY_ALREADY_DONE, MODDB_VISIBILITY_DECLINED } from "@domain/moddbVisibility"

let temporaryRoot: string
let userDataFolder: string
let appDataFolder: string

async function freshConfigManager(): Promise<typeof import("@src/config/configManager")> {
  vi.resetModules()
  return import("@src/config/configManager")
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "config-manager-"))
  userDataFolder = join(temporaryRoot, "userData")
  appDataFolder = join(temporaryRoot, "appData")
  mkdirSync(userDataFolder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", appDataFolder)
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  vi.mocked(saveAccountSecrets).mockReset()
  vi.mocked(saveAccountSecrets).mockResolvedValue(undefined)
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function minimalConfig(overrides: Partial<ConfigType> = {}): ConfigType {
  return {
    schemaVersion: 2,
    lastUsedInstallation: null,
    defaultInstallationsFolder: join(appDataFolder, "VSLInstallations"),
    defaultVersionsFolder: join(appDataFolder, "VSLGameVersions"),
    backupsFolder: join(appDataFolder, "VSLBackups"),
    window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
    account: null,
    installations: [],
    gameVersions: [],
    favMods: [],
    suspendedModUpdates: [],
    background: DEFAULT_BACKGROUND_ID,
    moddbVisibilityAnswer: DEFAULT_MODDB_VISIBILITY_ANSWER,
    customIcons: [],
    ...overrides
  }
}

describe("normalizeConfig: the document itself", () => {
  it("builds the default config from anything that is not an object", async () => {
    const { normalizeConfig, getConfig } = await freshConfigManager()
    const fromDefaults = await getConfig() // primes defaultConfig's folders under the temp appData

    for (const notAnObject of [null, undefined, "a string", 42, []]) {
      const result = normalizeConfig(notAnObject)
      assert.equal(result.defaultInstallationsFolder, fromDefaults.defaultInstallationsFolder)
      assert.deepEqual(result.installations, [])
    }
  })

  it("keeps an existing folder value exactly as stored, even one still carrying the pre-rebrand VSL folder names", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const legacyPaths = {
      defaultInstallationsFolder: join(appDataFolder, "VSLInstallations"),
      defaultVersionsFolder: join(appDataFolder, "VSLGameVersions"),
      backupsFolder: join(appDataFolder, "VSLBackups")
    }

    const result = normalizeConfig(legacyPaths)

    assert.equal(result.defaultInstallationsFolder, legacyPaths.defaultInstallationsFolder)
    assert.equal(result.defaultVersionsFolder, legacyPaths.defaultVersionsFolder)
    assert.equal(result.backupsFolder, legacyPaths.backupsFolder)
  })

  it("falls back to default window fields when window is not a record", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({ window: "not an object" })
    assert.deepEqual(result.window, { width: 1280, height: 720, x: 0, y: 0, maximized: false })
  })

  it("clamps every window field to its declared range and truncates fractions", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      window: { width: 100, height: 100_000, x: -999_999, y: 999_999, maximized: "yes" }
    })
    assert.equal(result.window.width, 1280, "out of range falls back to the default width, not a clamp to the floor")
    assert.ok(result.window.height <= 8_192)
    assert.ok(result.window.x >= -100_000)
    assert.ok(result.window.y <= 100_000)
    assert.equal(result.window.maximized, false)

    const fractional = normalizeConfig({ window: { width: 1280.9, height: 720.1, x: 0, y: 0, maximized: true } })
    assert.equal(fractional.window.width, 1280)
    assert.equal(fractional.window.height, 720)
  })

  it("keeps lastUsedInstallation null as null, distinct from an empty or invalid string falling back to null", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({ lastUsedInstallation: null }).lastUsedInstallation, null)
    assert.equal(normalizeConfig({ lastUsedInstallation: "install-1" }).lastUsedInstallation, "install-1")
    assert.equal(normalizeConfig({ lastUsedInstallation: 42 }).lastUsedInstallation, null)
    assert.equal(normalizeConfig({ lastUsedInstallation: "" }).lastUsedInstallation, null)
  })

  it("keeps favMods only when it is an array, filtering to safe integers and capping at 10,000", async () => {
    const { normalizeConfig, getConfig } = await freshConfigManager()
    const defaults = await getConfig()

    assert.deepEqual(normalizeConfig({ favMods: "not an array" }).favMods, defaults.favMods)
    assert.deepEqual(normalizeConfig({ favMods: [1, 2.5, "3", NaN, 4] }).favMods, [1, 4])

    const tooMany = Array.from({ length: 10_005 }, (_, i) => i)
    assert.equal(normalizeConfig({ favMods: tooMany }).favMods.length, 10_000)
  })

  it("keeps suspendedModUpdates only when it is an array of non-empty strings, capping at 10,000", async () => {
    const { normalizeConfig } = await freshConfigManager()

    assert.deepEqual(normalizeConfig({ suspendedModUpdates: "not an array" }).suspendedModUpdates, [])
    assert.deepEqual(normalizeConfig({ suspendedModUpdates: ["alpha", 3, "", null, "beta"] }).suspendedModUpdates, ["alpha", "beta"])

    const tooMany = Array.from({ length: 10_005 }, (_, i) => `mod-${i}`)
    assert.equal(normalizeConfig({ suspendedModUpdates: tooMany }).suspendedModUpdates.length, 10_000)
  })

  it("normalizes a config with no suspendedModUpdates field at all to an empty list", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.deepEqual(normalizeConfig({}).suspendedModUpdates, [])
  })
})

describe("normalizeConfig: installations", () => {
  it("drops entries that are not records, and entries missing an id or a path", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      installations: ["not a record", null, { name: "no id or path" }, { id: "only-id" }, { path: "only-path" }, { id: "a", path: "/a" }]
    })
    assert.deepEqual(
      result.installations.map((i) => i.id),
      ["a"]
    )
  })

  it("clamps backupsLimit, compressionLevel and lastTimePlayed to their declared ranges", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      installations: [{ id: "a", path: "/a", backupsLimit: -5, compressionLevel: 99, lastTimePlayed: -999 }]
    })
    const installation = result.installations[0]!
    assert.equal(installation.backupsLimit, 3, "out of range falls back to the default")
    assert.equal(installation.compressionLevel, DEFAULT_COMPRESSION_LEVEL, "the same level the add form proposes, not a second number")
    assert.equal(installation.lastTimePlayed, -1)

    const inRange = normalizeConfig({ installations: [{ id: "a", path: "/a", backupsLimit: 7, compressionLevel: 8.9, lastTimePlayed: 12_345 }] })
    assert.equal(inRange.installations[0]!.backupsLimit, 7)
    assert.equal(inRange.installations[0]!.compressionLevel, 8, "truncated, not rounded, and still in range so it is not the fallback")
    assert.equal(inRange.installations[0]!.lastTimePlayed, 12_345)
  })

  it("keeps backups only when they are records with a non-empty id and path, capped at 100", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      installations: [
        {
          id: "a",
          path: "/a",
          backups: ["not a record", null, { id: "", path: "/empty-id" }, { id: "no-path" }, { id: "b1", path: "/b1", date: 123 }]
        }
      ]
    })
    assert.deepEqual(result.installations[0]!.backups, [{ id: "b1", date: 123, path: "/b1" }])

    const tooMany = Array.from({ length: 105 }, (_, i) => ({ id: `b${i}`, path: `/b${i}` }))
    const capped = normalizeConfig({ installations: [{ id: "a", path: "/a", backups: tooMany }] })
    assert.equal(capped.installations[0]!.backups.length, 100)
  })

  it("falls back to [] when backups is not an array", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({ installations: [{ id: "a", path: "/a", backups: "nope" }] })
    assert.deepEqual(result.installations[0]!.backups, [])
  })

  it("truncates a string field past its own maximum length back to the default", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({ installations: [{ id: "a", path: "/a", envVars: "x".repeat(9_000) }] })
    assert.equal(result.installations[0]!.envVars, "")
  })

  it("caps the whole installations array at 1,000 entries", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const many = Array.from({ length: 1_005 }, (_, i) => ({ id: `i${i}`, path: `/i${i}` }))
    const result = normalizeConfig({ installations: many })
    assert.equal(result.installations.length, 1_000)
  })
})

describe("normalizeConfig: game versions", () => {
  it("drops entries that are not records, and entries missing a version or a path", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      gameVersions: ["nope", null, { version: "only-version" }, { path: "only-path" }, { version: "1.20.0", path: "/v" }]
    })
    assert.deepEqual(
      result.gameVersions.map((g) => g.version),
      ["1.20.0"]
    )
  })

  it("falls back to [] when gameVersions is not an array", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.deepEqual(normalizeConfig({ gameVersions: "nope" }).gameVersions, [])
  })

  // `linked` is the only thing telling "remove from list" apart from "delete this folder
  // off disk", so if normalization dropped it on every reload, a folder the player owns
  // would quietly become deletable again the next time the config loads. That is data
  // loss, not a cosmetic regression, so it gets its own coverage here.
  it("keeps linked: true across normalization", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({ gameVersions: [{ version: "1.20.0", path: "/v", linked: true }] })
    assert.equal(result.gameVersions[0]!.linked, true)
  })

  it("drops linked when it is absent or not a boolean, instead of keeping a stray value", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      gameVersions: [
        { version: "1.20.0", path: "/v" },
        { version: "1.20.1", path: "/v2", linked: "yes" },
        { version: "1.20.2", path: "/v3", linked: false }
      ]
    })
    assert.deepEqual(
      result.gameVersions.map((g) => g.linked),
      [undefined, undefined, undefined]
    )
  })
})

describe("normalizeConfig: custom icons", () => {
  it("drops entries that are not records, missing id or name, or whose icon does not end in .png", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      customIcons: ["nope", null, { id: "a", name: "A", icon: "a.jpg" }, { name: "no id", icon: "b.png" }, { id: "no-name", icon: "c.png" }, { id: "ok", name: "OK", icon: "OK.PNG", custom: true }]
    })
    assert.deepEqual(
      result.customIcons.map((i) => i.id),
      ["ok"]
    )
    assert.equal(result.customIcons[0]!.custom, true)
  })

  it("falls back to [] when customIcons is not an array", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.deepEqual(normalizeConfig({ customIcons: "nope" }).customIcons, [])
  })

  it("caps the whole customIcons array at 1,000 entries", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const many = Array.from({ length: 1_005 }, (_, i) => ({ id: `i${i}`, name: `I${i}`, icon: `i${i}.png` }))
    const result = normalizeConfig({ customIcons: many })
    assert.equal(result.customIcons.length, 1_000)
  })
})

describe("normalizeConfig: background", () => {
  it("defaults to the bundled scene when the field is missing, so an upgrade looks like it always did", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({}).background, DEFAULT_BACKGROUND_ID)
  })

  it("keeps a catalog id and the reserved custom id", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({ background: "village-lane" }).background, "village-lane")
    assert.equal(normalizeConfig({ background: CUSTOM_BACKGROUND_ID }).background, CUSTOM_BACKGROUND_ID)
  })

  it("falls back to the default for anything that is not a usable id", async () => {
    const { normalizeConfig } = await freshConfigManager()

    // A path, a traversal, an uppercase or space-carrying name, a non-string, and an id past the
    // length ceiling. None of these can name a file in the cache, so none survives normalization.
    for (const value of ["../../etc/passwd", "Village Lane", "village_lane", "-leading-dash", "trailing-dash-", "", 7, null, {}, "a".repeat(65)]) {
      assert.equal(normalizeConfig({ background: value }).background, DEFAULT_BACKGROUND_ID, String(value))
    }
  })

  it("never writes the session-only revision counter back out", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({ background: "village-lane", _backgroundRevision: 4 })._backgroundRevision, undefined)
  })
})

describe("normalizeConfig: moddbVisibilityAnswer", () => {
  it("reads a config written before the field existed as not asked yet", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({}).moddbVisibilityAnswer, DEFAULT_MODDB_VISIBILITY_ANSWER)
  })

  it("keeps every answer the prompt can record, so none of the three is ever asked twice", async () => {
    const { normalizeConfig } = await freshConfigManager()

    for (const answer of [MODDB_VISIBILITY_ACCEPTED, MODDB_VISIBILITY_DECLINED, MODDB_VISIBILITY_ALREADY_DONE]) {
      assert.equal(normalizeConfig({ moddbVisibilityAnswer: answer }).moddbVisibilityAnswer, answer)
    }
  })

  it("falls back to not-asked-yet for anything else, rather than inventing a consent", async () => {
    const { normalizeConfig } = await freshConfigManager()

    for (const value of ["yes", "ACCEPTED", "", 1, true, null, {}, ["accepted"]]) {
      assert.equal(normalizeConfig({ moddbVisibilityAnswer: value }).moddbVisibilityAnswer, DEFAULT_MODDB_VISIBILITY_ANSWER, String(value))
    }
  })
})

describe("ensureConfig", () => {
  it("creates the default config when none exists yet", async () => {
    const { ensureConfig, getConfig } = await freshConfigManager()
    assert.equal(await ensureConfig(), true)
    const config = await getConfig()
    assert.equal(config.schemaVersion >= 1, true)
  })

  it("recognizes a config already on disk without rewriting it", async () => {
    const configPath = join(userDataFolder, "config.json")
    writeFileSync(configPath, JSON.stringify(minimalConfig()), "utf-8")

    const { ensureConfig } = await freshConfigManager()
    assert.equal(await ensureConfig(), true)
  })

  it("returns false when checking for the config file itself throws", async () => {
    const configManager = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "pathExists").mockRejectedValueOnce(new Error("boom"))

    assert.equal(await configManager.ensureConfig(), false)
  })
})

describe("saveConfig and flushConfigWrites", () => {
  it("sets its own config path on the very first call, without ensureConfig running first", async () => {
    const { saveConfig, getConfig } = await freshConfigManager()
    assert.equal(await saveConfig(minimalConfig()), true)
    const reread = await getConfig()
    assert.equal(reread.defaultInstallationsFolder, minimalConfig().defaultInstallationsFolder)
  })

  it("coalesces two saves that overlap into the same scheduled write", async () => {
    const { saveConfig, flushConfigWrites, getConfig } = await freshConfigManager()
    const first = saveConfig(minimalConfig({ lastUsedInstallation: "a" }))
    // Still inside the 100ms debounce: this call has to join the already
    // scheduled write rather than queue a second one of its own.
    const second = saveConfig(minimalConfig({ lastUsedInstallation: "b" }))

    assert.deepEqual(await Promise.all([first, second]), [true, true])
    await flushConfigWrites()

    const reread = await getConfig()
    assert.equal(reread.lastUsedInstallation, "b", "the later config wins the coalesced write")
  })

  it("returns null when nothing is scheduled", async () => {
    const { flushConfigWrites } = await freshConfigManager()
    assert.equal(flushConfigWrites(), null)
  })

  it("swallows a failure cleaning up its own temp file, rather than fail the save over it", async () => {
    const { saveConfig, flushConfigWrites } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "remove").mockRejectedValueOnce(new Error("temp file already gone"))

    const result = await saveConfig(minimalConfig())
    await flushConfigWrites()

    assert.equal(result, true, "the write itself landed; only its own best-effort cleanup failed")
  })

  it("strips underscore-prefixed session-only fields before writing to disk", async () => {
    const { saveConfig, flushConfigWrites } = await freshConfigManager()
    const withSessionField = { ...minimalConfig(), _notifiedModUpdatesInstallations: ["install-1"] }

    await saveConfig(withSessionField)
    await flushConfigWrites()

    const fse = (await import("fs-extra")).default
    const onDisk = await fse.readJSON(join(userDataFolder, "config.json"))
    assert.equal("_notifiedModUpdatesInstallations" in onDisk, false)
  })
})

describe("getConfig: schema migration logging", () => {
  it("reports future-schema and reads the document as is, without downgrading it", async () => {
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(minimalConfig({ schemaVersion: 99 })), "utf-8")
    const { getConfig } = await freshConfigManager()
    const config = await getConfig()
    assert.equal(config.schemaVersion, 99)
  })

  it("reports unreadable and falls back to defaults for a document that parses but is not an object", async () => {
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(["not", "an", "object"]), "utf-8")
    const { getConfig } = await freshConfigManager()
    const config = await getConfig()
    assert.deepEqual(config.installations, [])
  })

  it("migrates a float-era document (a numeric version field, no schemaVersion) up to the current schema", async () => {
    const legacyDoc = { ...minimalConfig(), schemaVersion: undefined, version: 1.6 }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()
    assert.equal(config.schemaVersion, 3)
  })
})

describe("getConfig: legacy account secrets migration", () => {
  it("moves a valid legacy account's secrets to secure storage and re-saves the config", async () => {
    const legacyDoc = {
      ...minimalConfig(),
      account: {
        email: "player@example.test",
        playerName: "TestPlayer",
        playerUid: "uid-0001",
        playerEntitlements: null,
        hostGameServer: false,
        // Obviously-fake test secrets, never real credentials.
        sessionKey: "fake-session-key-0001",
        sessionSignature: "fake-session-signature-0001",
        mptoken: null
      }
    }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()

    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 1)
    assert.deepEqual(config.account, {
      email: "player@example.test",
      playerName: "TestPlayer",
      playerUid: "uid-0001",
      playerEntitlements: null,
      hostGameServer: false
    })
    // The legacy secret fields never reach the renderer-visible account.
    assert.equal("sessionKey" in (config.account as object), false)
  })

  it("discards an unparseable legacy account rather than migrate garbage", async () => {
    const legacyDoc = {
      ...minimalConfig(),
      // Carries a legacy secret key, so migration is attempted, but is
      // missing the fields parseLegacyAccount needs to build an account.
      account: { sessionKey: "fake-session-key", sessionSignature: "fake-session-signature", mptoken: null }
    }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()

    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 0)
    assert.equal(config.account, null)
  })

  it("logs a warning but still finishes when secure storage refuses the migrated secrets", async () => {
    vi.mocked(saveAccountSecrets).mockRejectedValueOnce(new Error("secure storage unavailable"))
    const legacyDoc = {
      ...minimalConfig(),
      account: {
        email: "player@example.test",
        playerName: "TestPlayer",
        playerUid: "uid-0002",
        playerEntitlements: null,
        hostGameServer: false,
        sessionKey: "fake-session-key-0002",
        sessionSignature: "fake-session-signature-0002",
        mptoken: null
      }
    }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()

    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 1)
    // The public half still comes through even though the secrets could not be stored.
    assert.equal(config.account?.playerUid, "uid-0002")
  })

  it("does not attempt a migration when the account carries none of the legacy secret fields", async () => {
    const doc = { ...minimalConfig(), account: { email: "a@b.c", playerName: "A", playerUid: "1", playerEntitlements: null, hostGameServer: false } }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(doc), "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 0)
  })
})
