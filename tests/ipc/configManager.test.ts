import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import "./helpers/electronMock"
import { setElectronAppVersion, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"
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
  saveAccountSecrets: vi.fn(async () => "saved" as const),
  adoptLegacySingleAccountSecrets: vi.fn(async () => false)
}))

import { adoptLegacySingleAccountSecrets, saveAccountSecrets } from "@src/ipc/accountStore"
import { ACCENT_PRESETS, DEFAULT_ACCENT_ID } from "@domain/accentColors"
import { CUSTOM_BACKGROUND_ID, DEFAULT_BACKGROUND_ID } from "@domain/backgrounds"
import { defaultModDbVisibility, MAX_COUNTED_VERSIONS } from "@domain/moddbVisibility"
import { DEFAULT_RECEIVE_BETA_UPDATES } from "@domain/appUpdate/betaUpdates"
import { DEFAULT_ALLOW_BASIC_SESSION_STORE } from "@domain/account/sessionStorage"
import { DEFAULT_MEASURE_PLAY_SESSIONS } from "@domain/sessions/sampling"
import { CURRENT_CONFIG_SCHEMA, legacyGameVersionId } from "@domain/config/migrations"

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
  setElectronAppVersion()

  vi.mocked(saveAccountSecrets).mockReset()
  vi.mocked(saveAccountSecrets).mockResolvedValue("saved")
  vi.mocked(adoptLegacySingleAccountSecrets).mockReset()
  vi.mocked(adoptLegacySingleAccountSecrets).mockResolvedValue(false)
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
    accounts: [],
    activeAccountId: null,
    installations: [],
    gameVersions: [],
    favMods: [],
    suspendedModUpdates: [],
    background: DEFAULT_BACKGROUND_ID,
    accentColor: DEFAULT_ACCENT_ID,
    moddbVisibility: defaultModDbVisibility(),
    modSuggestionsConsent: null,
    dismissedModSuggestions: [],
    modSuggestionsFolded: false,
    receiveBetaUpdates: DEFAULT_RECEIVE_BETA_UPDATES,
    measurePlaySessions: DEFAULT_MEASURE_PLAY_SESSIONS,
    allowBasicSessionStore: DEFAULT_ALLOW_BASIC_SESSION_STORE,
    lastSeenChangelogVersion: "",
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

  it("keeps Mod suggestions consent explicit and never regresses it to a missing default", async () => {
    const { normalizeConfig } = await freshConfigManager()

    assert.equal(normalizeConfig({}).modSuggestionsConsent, null)
    assert.equal(normalizeConfig({ modSuggestionsConsent: true }).modSuggestionsConsent, true)
    assert.equal(normalizeConfig({ modSuggestionsConsent: false }).modSuggestionsConsent, false)
    for (const value of ["true", "yes", 1, {}, []]) assert.equal(normalizeConfig({ modSuggestionsConsent: value }).modSuggestionsConsent, null, String(value))
  })

  it("keeps valid dismissed Mod suggestions and never regresses them to a missing default", async () => {
    const { normalizeConfig } = await freshConfigManager()

    assert.deepEqual(normalizeConfig({}).dismissedModSuggestions, [])
    assert.deepEqual(normalizeConfig({ dismissedModSuggestions: [4, 4, 2.5, "3", 0, -1, 7] }).dismissedModSuggestions, [4, 7])
    assert.deepEqual(normalizeConfig({ dismissedModSuggestions: "not an array" }).dismissedModSuggestions, [])
  })

  it("normalizes the folded flag to a strict boolean", async () => {
    const { normalizeConfig } = await freshConfigManager()

    assert.equal(normalizeConfig({}).modSuggestionsFolded, false)
    assert.equal(normalizeConfig({ modSuggestionsFolded: true }).modSuggestionsFolded, true)
    for (const value of ["true", 1, null, {}, []]) assert.equal(normalizeConfig({ modSuggestionsFolded: value }).modSuggestionsFolded, false, String(value))
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
  it("keeps stable game-version identity and defaults a missing label to the version", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({ gameVersions: [{ id: "gv-vanilla", version: "1.22.7", path: "/versions/vanilla" }] })
    const normalized = result.gameVersions[0] as GameVersionType & { label: string }

    assert.equal(normalized.id, "gv-vanilla")
    assert.equal(normalized.label, "1.22.7")
  })

  it("keeps an installation's gameVersionId while retaining its version number", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({ installations: [{ id: "install-1", path: "/installations/1", version: "1.22.7", gameVersionId: "gv-optimum" }] })
    const normalized = result.installations[0] as InstallationType & { gameVersionId: string | null }

    assert.equal(normalized.gameVersionId, "gv-optimum")
    assert.equal(normalized.version, "1.22.7")
  })

  it("repairs damaged current-schema identities on every normalization and preserves labels", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      schemaVersion: CURRENT_CONFIG_SCHEMA,
      gameVersions: [
        { version: "1.22.7", label: "Vanilla", path: "/versions/vanilla" },
        { id: "", version: "1.22.7", label: "Optimum", path: "/versions/optimum" },
        { id: "duplicate", version: "1.21.0", label: "Keep this", path: "/versions/a" },
        { id: "duplicate", version: "1.21.0", label: "Second", path: "/versions/b" },
        { id: "valid", version: "1.20.0", path: "/versions/valid" }
      ]
    })

    assert.deepEqual(
      result.gameVersions.map((version) => ({ path: version.path, id: version.id, label: version.label })),
      [
        { path: "/versions/vanilla", id: legacyGameVersionId("1.22.7", "/versions/vanilla"), label: "Vanilla" },
        { path: "/versions/optimum", id: legacyGameVersionId("1.22.7", "/versions/optimum"), label: "Optimum" },
        { path: "/versions/a", id: "duplicate", label: "Keep this" },
        { path: "/versions/b", id: legacyGameVersionId("1.21.0", "/versions/b"), label: "Second" },
        { path: "/versions/valid", id: "valid", label: "1.20.0" }
      ]
    )
  })

  it("relinks only absent installation ids, leaves explicit null alone, and leaves ambiguous versions null", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      schemaVersion: CURRENT_CONFIG_SCHEMA,
      gameVersions: [
        { id: "one", version: "1.22.7", label: "One", path: "/versions/one" },
        { id: "two", version: "1.22.7", label: "Two", path: "/versions/two" }
      ],
      installations: [
        { id: "absent", path: "/installs/absent", version: "1.21.0" },
        { id: "null", path: "/installs/null", version: "1.22.7", gameVersionId: null },
        { id: "ambiguous", path: "/installs/ambiguous", version: "1.22.7" }
      ]
    })

    assert.equal(result.installations.find((installation) => installation.id === "absent")?.gameVersionId, null)
    assert.equal(result.installations.find((installation) => installation.id === "null")?.gameVersionId, null)
    assert.equal(result.installations.find((installation) => installation.id === "ambiguous")?.gameVersionId, null)
  })

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

  // Same kind of loss as `linked` above, in the other direction: a build the player
  // patched would read as plain again on the next load, and the two actions that only
  // exist on a patched row would be gone with it.
  it("keeps a build variant across normalization", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({ gameVersions: [{ version: "1.22.7", path: "/v", label: "1.22.7 Optimum 0.3.14", variant: { name: "Optimum", version: "0.3.14" } }] })
    assert.deepEqual(result.gameVersions[0]!.variant, { name: "Optimum", version: "0.3.14" })
  })

  it("drops a variant a probe would never have produced", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({
      gameVersions: [
        { version: "1.22.7", path: "/v1" },
        { version: "1.22.7", path: "/v2", variant: { name: "Sodium", version: "0.3.14" } },
        { version: "1.22.7", path: "/v3", variant: { name: "Optimum", version: "latest" } },
        { version: "1.22.7", path: "/v4", variant: "Optimum v0.3.14" }
      ]
    })
    assert.deepEqual(
      result.gameVersions.map((g) => g.variant),
      [undefined, undefined, undefined, undefined]
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

describe("normalizeConfig: accentColor", () => {
  it("defaults to the current brand preset when the field is missing, so an upgrade looks like it always did", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({}).accentColor, DEFAULT_ACCENT_ID)
  })

  it("keeps every preset id the palette lists", async () => {
    const { normalizeConfig } = await freshConfigManager()
    for (const preset of ACCENT_PRESETS) assert.equal(normalizeConfig({ accentColor: preset.id }).accentColor, preset.id)
  })

  it("falls back to the default for anything that does not name a listed preset", async () => {
    const { normalizeConfig } = await freshConfigManager()

    for (const value of ["#d49754", "AMBER", "", 7, null, {}, ["amber"]]) {
      assert.equal(normalizeConfig({ accentColor: value }).accentColor, DEFAULT_ACCENT_ID, String(value))
    }
  })

  /**
   * The field's whole point: adding it must not need a schema bump. A beta.9 (schema 4) document
   * never heard of accentColor, and an older build reading a schema 5 document this launcher wrote
   * drops the field it does not recognize and saves without it. Both land back here with no field
   * at all, and both must read as the shipped default rather than fail to migrate or start.
   */
  it("keeps a beta.9 (schema 4) document with no accentColor field readable, defaulting the accent", async () => {
    const legacyDoc: Record<string, unknown> = { ...minimalConfig({ schemaVersion: 4 }) }
    delete legacyDoc.accentColor
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()
    assert.equal(config.accentColor, DEFAULT_ACCENT_ID)
    assert.equal(config.schemaVersion, CURRENT_CONFIG_SCHEMA)
  })

  it("keeps a schema 5 document an older build re-saved without accentColor readable, defaulting the accent", async () => {
    const doc: Record<string, unknown> = { ...minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA, accentColor: "teal" }) }
    delete doc.accentColor
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(doc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()
    assert.equal(config.accentColor, DEFAULT_ACCENT_ID)
    assert.equal(config.schemaVersion, CURRENT_CONFIG_SCHEMA)
  })
})

describe("normalizeConfig: installation servers (#460)", () => {
  function installation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: "i-1", path: join(appDataFolder, "installations", "one"), ...overrides }
  }

  const server = { id: "s-1", name: "Home", host: "play.example.com", port: 42_420, lastLaunched: -1 }

  it("reads a stored list back unchanged", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const config = normalizeConfig({ installations: [installation({ servers: [server] })] })

    assert.deepEqual(config.installations[0]?.servers, [server])
  })

  it("leaves the field off entirely for an Installation with no servers, so an older build reads it the same", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const config = normalizeConfig({ installations: [installation(), installation({ id: "i-2", servers: [] })] })

    assert.equal("servers" in (config.installations[0] ?? {}), false)
    assert.equal("servers" in (config.installations[1] ?? {}), false)
  })

  it("drops a junk entry and keeps the Installation, never losing it over one bad row", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const config = normalizeConfig({ installations: [installation({ servers: [{ id: "s-2", name: "Broken", host: "not a host", port: 1 }, server] })] })

    assert.deepEqual(
      config.installations[0]?.servers?.map((entry) => entry.id),
      ["s-1"]
    )
  })

  it("drops a servers field that is not a list", async () => {
    const { normalizeConfig } = await freshConfigManager()
    for (const value of ["play.example.com", 7, {}, null]) {
      assert.equal("servers" in (normalizeConfig({ installations: [installation({ servers: value })] }).installations[0] ?? {}), false, String(value))
    }
  })

  /**
   * The field's whole point, same as accentColor's and lastSeenChangelogVersion's: adding it must
   * not need a schema bump. A beta.9 (schema 4) document never heard of it, and an older build
   * reading a document this launcher wrote drops the field and saves without it. Both land back
   * here with no field at all, and both must read as an Installation with no servers.
   */
  it("keeps a beta.9 (schema 4) document with no servers field readable, and does not bump the schema for one", async () => {
    const legacyDoc: Record<string, unknown> = { ...minimalConfig({ schemaVersion: 4 }), installations: [installation()] }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()

    assert.equal(config.installations[0]?.servers, undefined)
    assert.equal(config.schemaVersion, CURRENT_CONFIG_SCHEMA)
  })

  it("round trips a list through a save and a fresh read", async () => {
    const doc: Record<string, unknown> = { ...minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA }), installations: [installation({ servers: [server] })] }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(doc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()

    assert.deepEqual(config.installations[0]?.servers, [server])
  })
})

describe("normalizeConfig: lastSeenChangelogVersion", () => {
  it("defaults to empty when the field is missing, which the what's new dialog reads as a fresh install", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({}).lastSeenChangelogVersion, "")
  })

  it("keeps a stored version string as is", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({ lastSeenChangelogVersion: "1.7.0-beta.9" }).lastSeenChangelogVersion, "1.7.0-beta.9")
  })

  it("falls back to empty for anything that is not a bounded string", async () => {
    const { normalizeConfig } = await freshConfigManager()
    for (const value of [7, null, {}, ["1.0.0"], "x".repeat(200)]) {
      assert.equal(normalizeConfig({ lastSeenChangelogVersion: value }).lastSeenChangelogVersion, "", String(value))
    }
  })

  /**
   * The field's whole point, same as accentColor's: adding it must not need a schema bump. A
   * beta.9 (schema 4) document never heard of it, and an older build reading a schema this
   * launcher wrote drops the field it does not recognize and saves without it. Both land back
   * here with no field at all, and both must read as empty rather than fail to migrate or start.
   */
  it("keeps a beta.9 (schema 4) document with no lastSeenChangelogVersion field readable, defaulting to empty", async () => {
    const legacyDoc: Record<string, unknown> = { ...minimalConfig({ schemaVersion: 4 }) }
    delete legacyDoc.lastSeenChangelogVersion
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()
    assert.equal(config.lastSeenChangelogVersion, "")
    assert.equal(config.schemaVersion, CURRENT_CONFIG_SCHEMA)
  })

  it("keeps a schema-current document an older build re-saved without lastSeenChangelogVersion readable, defaulting to empty", async () => {
    const doc: Record<string, unknown> = { ...minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA, lastSeenChangelogVersion: "1.7.0" }) }
    delete doc.lastSeenChangelogVersion
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(doc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()
    assert.equal(config.lastSeenChangelogVersion, "")
    assert.equal(config.schemaVersion, CURRENT_CONFIG_SCHEMA)
  })
})

describe("normalizeConfig: moddbVisibility", () => {
  it("reads a config written before the field existed as nobody having answered", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.deepEqual(normalizeConfig({}).moddbVisibility, defaultModDbVisibility())
  })

  it("keeps a stored answer whole, so a version is neither asked about nor counted twice", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const stored = { policy: "always", answeredVersion: "1.7.0-beta.10", countedVersions: ["1.7.0-beta.9", "1.7.0-beta.10"] }

    assert.deepEqual(normalizeConfig({ moddbVisibility: stored }).moddbVisibility, stored)
  })

  it("falls back to nobody-has-answered for anything else, rather than inventing a consent", async () => {
    const { normalizeConfig } = await freshConfigManager()

    for (const value of [1, true, null, ["always"], { policy: "ALWAYS" }, { policy: "yes" }]) {
      assert.equal(normalizeConfig({ moddbVisibility: value }).moddbVisibility.policy, "ask", JSON.stringify(value))
    }
  })

  it("drops unusable versions out of the counted list and caps what is left", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const raw = [7, "", null, "1.7.0-beta.9", "1.7.0-beta.9", "x".repeat(200), ...Array.from({ length: MAX_COUNTED_VERSIONS }, (_unused, index) => `1.7.0-beta.${index + 10}`)]

    const counted = normalizeConfig({ moddbVisibility: { policy: "always", countedVersions: raw } }).moddbVisibility.countedVersions

    assert.equal(counted.length, MAX_COUNTED_VERSIONS)
    assert.equal(counted.includes("1.7.0-beta.9"), false, "the oldest entry should have been trimmed off the front")
    assert.equal(counted.at(-1), `1.7.0-beta.${MAX_COUNTED_VERSIONS + 9}`)
  })

  /**
   * #219's single answer, migrated. Nobody recorded which version it was given under, so it reads
   * as an answer for the version running now: the question comes back on the next new version
   * rather than on this one, and an acceptance's own count is remembered so switching to "always"
   * later cannot hit that same listing entry twice.
   */
  it("reads a #219 answer as one given for the running version", async () => {
    setElectronAppVersion("1.7.0-beta.10")
    const { normalizeConfig } = await freshConfigManager()

    assert.deepEqual(normalizeConfig({ moddbVisibilityAnswer: "accepted" }).moddbVisibility, {
      policy: "ask",
      answeredVersion: "1.7.0-beta.10",
      countedVersions: ["1.7.0-beta.10"]
    })

    for (const answer of ["declined", "already-done"]) {
      assert.deepEqual(normalizeConfig({ moddbVisibilityAnswer: answer }).moddbVisibility, { policy: "ask", answeredVersion: "1.7.0-beta.10", countedVersions: [] }, answer)
    }
  })

  it("reads a #219 config that was never answered as nobody having answered", async () => {
    setElectronAppVersion("1.7.0-beta.10")
    const { normalizeConfig } = await freshConfigManager()

    for (const answer of ["unasked", "ACCEPTED", ""]) {
      assert.deepEqual(normalizeConfig({ moddbVisibilityAnswer: answer }).moddbVisibility, defaultModDbVisibility(), answer)
    }
  })

  it("prefers the field over the #219 string when a config somehow carries both", async () => {
    setElectronAppVersion("1.7.0-beta.10")
    const { normalizeConfig } = await freshConfigManager()
    const stored = { policy: "never", answeredVersion: "1.7.0-beta.9", countedVersions: [] }

    assert.deepEqual(normalizeConfig({ moddbVisibility: stored, moddbVisibilityAnswer: "accepted" }).moddbVisibility, stored)
  })

  /**
   * Same point accentColor and lastSeenChangelogVersion already make: adding a field must not need
   * a schema bump. A beta.9 (schema 4) document never heard of this one, and an older build
   * reading a schema 5 document this launcher wrote drops what it does not recognize and saves
   * without it. Both land back here with no field at all, and both must read as an unanswered
   * question rather than fail to migrate or start.
   */
  it("keeps a beta.9 (schema 4) document with no moddbVisibility field readable", async () => {
    const legacyDoc: Record<string, unknown> = { ...minimalConfig({ schemaVersion: 4 }) }
    delete legacyDoc.moddbVisibility
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()
    assert.deepEqual(config.moddbVisibility, defaultModDbVisibility())
    assert.equal(config.schemaVersion, CURRENT_CONFIG_SCHEMA)
  })

  it("migrates a beta.9 (schema 4) document that still carries the #219 answer, and writes it back under the new field", async () => {
    setElectronAppVersion("1.7.0-beta.10")
    const legacyDoc: Record<string, unknown> = { ...minimalConfig({ schemaVersion: 4 }) }
    delete legacyDoc.moddbVisibility
    legacyDoc.moddbVisibilityAnswer = "accepted"
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig, saveConfig } = await freshConfigManager()
    const config = await getConfig()
    assert.deepEqual(config.moddbVisibility, { policy: "ask", answeredVersion: "1.7.0-beta.10", countedVersions: ["1.7.0-beta.10"] })

    // The round trip: what a later launch reads back carries the new field and nothing of the old.
    assert.equal(await saveConfig(config), true)
    const written = JSON.parse(readFileSync(join(userDataFolder, "config.json"), "utf-8"))
    assert.deepEqual(written.moddbVisibility, config.moddbVisibility)
    assert.equal("moddbVisibilityAnswer" in written, false)
  })
})

describe("normalizeConfig: receiveBetaUpdates", () => {
  it("reads a config written before the field existed as nobody having answered", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({}).receiveBetaUpdates, DEFAULT_RECEIVE_BETA_UPDATES)
  })

  it("keeps an explicit answer, both ways round, since each overrides what the running version would say", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({ receiveBetaUpdates: true }).receiveBetaUpdates, true)
    assert.equal(normalizeConfig({ receiveBetaUpdates: false }).receiveBetaUpdates, false)
  })

  it("falls back to no answer for anything that is not a boolean", async () => {
    const { normalizeConfig } = await freshConfigManager()

    for (const value of ["true", "false", "yes", 1, 0, null, {}, [true]]) {
      assert.equal(normalizeConfig({ receiveBetaUpdates: value }).receiveBetaUpdates, DEFAULT_RECEIVE_BETA_UPDATES, String(value))
    }
  })
})

/**
 * The opt-in that lets a session be kept without a system keyring (#481). It weakens where a
 * session lives, so the only thing that may turn it on is the toggle writing a real `true`: every
 * other spelling, and every config that has never been asked, reads as off.
 */
describe("normalizeConfig: allowBasicSessionStore", () => {
  it("reads a config written before the setting existed as off", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({}).allowBasicSessionStore, DEFAULT_ALLOW_BASIC_SESSION_STORE)
    assert.equal(DEFAULT_ALLOW_BASIC_SESSION_STORE, false, "the shipped default is off, and a change here is a change to what a fresh install stores")
  })

  it("keeps an explicit answer, both ways round", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({ allowBasicSessionStore: true }).allowBasicSessionStore, true)
    assert.equal(normalizeConfig({ allowBasicSessionStore: false }).allowBasicSessionStore, false)
  })

  it("stays off for anything that is not a boolean, a hand-edited yes included", async () => {
    const { normalizeConfig } = await freshConfigManager()

    for (const value of ["true", "yes", "on", 1, null, {}, [true]]) {
      assert.equal(normalizeConfig({ allowBasicSessionStore: value }).allowBasicSessionStore, false, String(value))
    }
  })

  it("round trips through a save and a fresh read, which is what the next startup reads the switch off", async () => {
    const { saveConfig, normalizeConfig } = await freshConfigManager()

    assert.equal(await saveConfig(normalizeConfig({ allowBasicSessionStore: true })), true)

    const { getConfig } = await freshConfigManager()
    assert.equal((await getConfig()).allowBasicSessionStore, true)
    assert.equal(JSON.parse(readFileSync(join(userDataFolder, "config.json"), "utf-8")).allowBasicSessionStore, true, "and it is on disk, where main/index.ts reads it before Electron starts")
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

  it("shares one pass over the disk when a second caller arrives before the first finishes", async () => {
    const { ensureConfig } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    const configPath = join(userDataFolder, "config.json")
    const pathExists = vi.spyOn(fse, "pathExists")

    // Both calls are in flight before either has looked at the disk. That is the first-run overlap
    // between the window's `ready-to-show` handler and the renderer's first GET_CONFIG, and without
    // the shared promise each one finds no file and writes its own default.
    const [first, second] = await Promise.all([ensureConfig(), ensureConfig()])

    assert.equal(first, true)
    assert.equal(second, true)
    assert.equal(pathExists.mock.calls.filter(([target]) => target === configPath).length, 1, "the second caller joins the first pass instead of starting its own")
  })

  it("does not cache a failed pass, so a later caller runs the check again", async () => {
    const { ensureConfig } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    const pathExists = vi.spyOn(fse, "pathExists").mockRejectedValueOnce(new Error("boom"))

    assert.equal(await ensureConfig(), false)
    // A stat failure is not a verdict about the file, so the promise is cleared in a `finally` and
    // the next caller looks again rather than inheriting the rejection. The write stays suppressed
    // for the rest of the session either way, which is the pre-existing behaviour.
    await ensureConfig()
    assert.equal(pathExists.mock.calls.length, 2)
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

  /**
   * The normaliser is what drops these, not the writer: it builds a fixed literal field by field,
   * so a key it does not name cannot come out the other side. Asserted on both, because the day
   * `normalizeConfig` grows a spread of its input is the day a session-only marker reaches disk.
   */
  it("strips underscore-prefixed session-only fields before writing to disk", async () => {
    const { saveConfig, flushConfigWrites, normalizeConfig } = await freshConfigManager()
    const withSessionField = { ...minimalConfig(), _notifiedModUpdatesInstallations: ["install-1"] }

    assert.equal("_notifiedModUpdatesInstallations" in normalizeConfig(withSessionField), false)

    await saveConfig(withSessionField)
    await flushConfigWrites()

    const fse = (await import("fs-extra")).default
    const onDisk = await fse.readJSON(join(userDataFolder, "config.json"))
    assert.equal("_notifiedModUpdatesInstallations" in onDisk, false)
  })

  // #553: a hand-edited config.json is unreadable to a player when it is one line of minified
  // JSON. writeJsonAtomic defaults to no spacing at all; the config writer has to ask for two
  // spaces explicitly, the same way the modpack export already does for the same reason.
  it("writes config.json indented two spaces, and the result parses back equal (#553)", async () => {
    const { saveConfig, flushConfigWrites, normalizeConfig } = await freshConfigManager()
    const config = minimalConfig({ lastUsedInstallation: "install-1" })

    await saveConfig(config)
    await flushConfigWrites()

    const raw = readFileSync(join(userDataFolder, "config.json"), "utf-8")
    assert.equal(raw, JSON.stringify(JSON.parse(raw), undefined, 2), "the file on disk is exactly its own content pretty-printed with two spaces")
    assert.ok(raw.includes("\n  "), "at least one line is indented two spaces")
    assert.deepEqual(JSON.parse(raw), normalizeConfig(config))
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
    assert.equal(config.schemaVersion, CURRENT_CONFIG_SCHEMA)
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
    assert.deepEqual(vi.mocked(saveAccountSecrets).mock.calls[0]![0], "uid-0001", "keyed by the account's own playerUid")
    assert.deepEqual(config.accounts, [
      {
        email: "player@example.test",
        playerName: "TestPlayer",
        playerUid: "uid-0001",
        playerEntitlements: null,
        hostGameServer: false
      }
    ])
    assert.equal(config.activeAccountId, "uid-0001")
    // The legacy secret fields never reach the renderer-visible account.
    assert.equal("sessionKey" in config.accounts[0]!, false)
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
    assert.deepEqual(config.accounts, [])
    assert.equal(config.activeAccountId, null)
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
    assert.equal(config.activeAccountId, "uid-0002")
    assert.equal(config.accounts[0]?.playerUid, "uid-0002")
  })

  it("does not attempt a migration when the account carries none of the legacy secret fields", async () => {
    const doc = { ...minimalConfig(), account: { email: "a@b.c", playerName: "A", playerUid: "1", playerEntitlements: null, hostGameServer: false } }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(doc), "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 0)
  })
})

describe("normalizeConfig: accounts", () => {
  it("drops entries that are not readable accounts, and deduplicates by playerUid, first wins", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const account = { email: "a@b.c", playerName: "A", playerUid: "uid-a", playerEntitlements: null, hostGameServer: false }
    const duplicate = { ...account, playerName: "A (stale)" }

    const result = normalizeConfig({ accounts: ["not a record", null, { email: "no uid" }, account, duplicate] })

    assert.deepEqual(
      result.accounts.map((a) => a.playerName),
      ["A"]
    )
  })

  it("caps the accounts array at 50 entries", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const many = Array.from({ length: 55 }, (_, i) => ({ email: `p${i}@b.c`, playerName: `P${i}`, playerUid: `uid-${i}`, playerEntitlements: null, hostGameServer: false }))
    const result = normalizeConfig({ accounts: many })
    assert.equal(result.accounts.length, 50)
  })

  it("falls back to [] when accounts is not an array", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.deepEqual(normalizeConfig({ accounts: "nope" }).accounts, [])
  })

  it("strips session credentials from every entry, the same way a single account never carried them", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const withSecrets = {
      email: "a@b.c",
      playerName: "A",
      playerUid: "uid-a",
      playerEntitlements: null,
      hostGameServer: false,
      sessionKey: "fake-key",
      sessionSignature: "fake-signature",
      mptoken: "fake-mptoken"
    }

    const result = normalizeConfig({ accounts: [withSecrets] })

    assert.equal(result.accounts.length, 1)
    for (const field of ["sessionKey", "sessionSignature", "mptoken"]) assert.equal(field in result.accounts[0]!, false, field)
  })
})

describe("normalizeConfig: activeAccountId", () => {
  const accountA = { email: "a@b.c", playerName: "A", playerUid: "uid-a", playerEntitlements: null, hostGameServer: false }
  const accountB = { email: "b@b.c", playerName: "B", playerUid: "uid-b", playerEntitlements: null, hostGameServer: false }

  it("keeps an activeAccountId that names a saved account", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({ accounts: [accountA, accountB], activeAccountId: "uid-b" })
    assert.equal(result.activeAccountId, "uid-b")
  })

  it("falls back to the first saved account when the id names nobody", async () => {
    const { normalizeConfig } = await freshConfigManager()
    const result = normalizeConfig({ accounts: [accountA, accountB], activeAccountId: "uid-gone" })
    assert.equal(result.activeAccountId, "uid-a")
  })

  it("is null when there are no saved accounts, whatever the stored id says", async () => {
    const { normalizeConfig } = await freshConfigManager()
    assert.equal(normalizeConfig({ accounts: [], activeAccountId: "uid-a" }).activeAccountId, null)
    assert.equal(normalizeConfig({}).activeAccountId, null)
  })
})

describe("getConfig: account store re-key migration", () => {
  it("re-keys the secret store under the legacy account's playerUid", async () => {
    const legacyDoc = { ...minimalConfig(), account: { email: "a@b.c", playerName: "A", playerUid: "uid-rekey", playerEntitlements: null, hostGameServer: false } }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")
    vi.mocked(adoptLegacySingleAccountSecrets).mockResolvedValueOnce(true)

    const { getConfig } = await freshConfigManager()
    await getConfig()

    assert.equal(vi.mocked(adoptLegacySingleAccountSecrets).mock.calls.length, 1)
    assert.equal(vi.mocked(adoptLegacySingleAccountSecrets).mock.calls[0]![0], "uid-rekey")
  })

  it("does nothing when there is no readable account to key the store by", async () => {
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(minimalConfig()), "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    assert.equal(vi.mocked(adoptLegacySingleAccountSecrets).mock.calls.length, 0)
  })

  it("logs a warning but still finishes when re-keying throws", async () => {
    const legacyDoc = { ...minimalConfig(), account: { email: "a@b.c", playerName: "A", playerUid: "uid-throws", playerEntitlements: null, hostGameServer: false } }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")
    vi.mocked(adoptLegacySingleAccountSecrets).mockRejectedValueOnce(new Error("boom"))

    const { getConfig } = await freshConfigManager()
    const config = await getConfig()

    assert.equal(config.activeAccountId, "uid-throws", "the document still migrates even though re-keying the store failed")
  })

  it("asks again on the next launch when a locked keyring burned the first attempt", async () => {
    const legacyDoc = { ...minimalConfig(), account: { email: "a@b.c", playerName: "A", playerUid: "uid-retry", playerEntitlements: null, hostGameServer: false } }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")
    vi.mocked(adoptLegacySingleAccountSecrets).mockRejectedValueOnce(new Error("keyring locked"))

    const first = await freshConfigManager()
    await first.getConfig()
    await first.flushConfigWrites()

    // The commit the retry has to survive: schema 4 on disk, with no `account` field left to key the store by.
    const fse = (await import("fs-extra")).default
    const onDisk = await fse.readJSON(join(userDataFolder, "config.json"))
    assert.equal(onDisk.schemaVersion, CURRENT_CONFIG_SCHEMA)
    assert.equal("account" in onDisk, false)

    const second = await freshConfigManager()
    const config = await second.getConfig()

    assert.deepEqual(vi.mocked(adoptLegacySingleAccountSecrets).mock.calls, [["uid-retry"], ["uid-retry"]], "a v1 store still on disk is retried, keyed by the same account")
    assert.equal(config.activeAccountId, "uid-retry")
  })
})

describe("getConfig: config.json backup before a schema migration", () => {
  function backupPath(): string {
    return join(userDataFolder, "config.pre-migration.bak.json")
  }

  it("copies the pre-migration document once a migration actually runs", async () => {
    const legacyDoc = minimalConfig({ schemaVersion: 2 })
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    const fse = (await import("fs-extra")).default
    assert.equal(await fse.pathExists(backupPath()), true)
    const backed = await fse.readJSON(backupPath())
    assert.equal(backed.schemaVersion, 2, "the backup holds the document exactly as it was before migrating, not the migrated result")
  })

  it("takes no backup when the document is already at the current schema", async () => {
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA })), "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    const fse = (await import("fs-extra")).default
    assert.equal(await fse.pathExists(backupPath()), false)
  })

  it("keeps the first backup rather than overwriting it on a later migration", async () => {
    const fse = (await import("fs-extra")).default
    await fse.ensureDir(userDataFolder)
    await fse.writeJSON(backupPath(), { schemaVersion: 1, sentinel: "already there" })
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(minimalConfig({ schemaVersion: 2 })), "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    const backed = await fse.readJSON(backupPath())
    assert.equal(backed.sentinel, "already there")
  })

  const LEGACY_ACCOUNT = {
    email: "player@example.test",
    playerName: "TestPlayer",
    playerUid: "uid-0296",
    playerEntitlements: null,
    hostGameServer: false,
    // Obviously-fake test secrets, never real credentials.
    sessionKey: "fake-session-key-0296",
    sessionSignature: "fake-session-signature-0296",
    mptoken: "fake-mptoken-0296"
  }

  it("does not carry the migrated session secrets into the backup (#296)", async () => {
    const legacyDoc = { ...minimalConfig({ schemaVersion: 2 }), account: LEGACY_ACCOUNT }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    const fse = (await import("fs-extra")).default
    assert.equal(await fse.pathExists(backupPath()), true, "the migration still leaves a recovery snapshot")
    const backed = await fse.readJSON(backupPath())
    assert.equal(backed.schemaVersion, 2, "still the pre-migration document shape")
    assert.equal(backed.account.playerUid, "uid-0296", "the non-secret account fields are kept")
    for (const field of ["sessionKey", "sessionSignature", "mptoken"]) {
      assert.equal(field in backed.account, false, `${field} must not sit in cleartext in the backup`)
    }
  })

  it("scrubs session secrets a pre-#296 build already wrote into an existing backup", async () => {
    const fse = (await import("fs-extra")).default
    await fse.ensureDir(userDataFolder)
    // The file a pre-fix build left behind: a verbatim copy of the pre-secure-storage config.json.
    await fse.writeJSON(backupPath(), { schemaVersion: 2, account: LEGACY_ACCOUNT })
    // The live config is already migrated, so no migration runs on this launch.
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA })), "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    const backed = await fse.readJSON(backupPath())
    assert.equal(backed.schemaVersion, 2, "the rest of the snapshot is left as it was")
    assert.equal(backed.account.playerName, "TestPlayer")
    for (const field of ["sessionKey", "sessionSignature", "mptoken"]) {
      assert.equal(field in backed.account, false, `${field} must be gone from the pre-existing backup`)
    }
  })

  it.skipIf(process.platform === "win32")("writes the backup owner-only", async () => {
    const { statSync } = await import("node:fs")
    const legacyDoc = { ...minimalConfig({ schemaVersion: 2 }), account: LEGACY_ACCOUNT }
    writeFileSync(join(userDataFolder, "config.json"), JSON.stringify(legacyDoc), "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    assert.equal(statSync(backupPath()).mode & 0o777, 0o600)
  })
})

/**
 * #554: a config.json a player hand-edited into invalid JSON (one trailing comma is enough) used
 * to be silently replaced by defaults, taking every Installation, account and setting with it.
 * getConfig now copies the unreadable file aside before writing anything, tries the last good
 * pre-migration snapshot, and only falls back to defaults when that is unusable too.
 */
describe("getConfig: an unreadable config.json is preserved and recovered (#554)", () => {
  const INVALID_JSON = '{"schemaVersion": 2, "lastUsedInstallation": null,}' // trailing comma

  function configPath(): string {
    return join(userDataFolder, "config.json")
  }

  function backupPath(): string {
    return join(userDataFolder, "config.pre-migration.bak.json")
  }

  function unreadableCopies(): string[] {
    return readdirSync(userDataFolder).filter((name) => /^config\.unreadable-.*\.json$/.test(name))
  }

  it("copies the unreadable file aside byte for byte before writing anything", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")

    const { getConfig } = await freshConfigManager()
    await getConfig()

    const [copy, ...rest] = unreadableCopies()
    assert.equal(rest.length, 0)
    assert.ok(copy)
    assert.equal(readFileSync(join(userDataFolder, copy), "utf-8"), INVALID_JSON, "the preserved copy is the exact original bytes, not a reparsed or reformatted version")
  })

  it("starts from the pre-migration backup when it is readable, and saves it as config.json", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")
    const fse = (await import("fs-extra")).default
    await fse.writeJSON(backupPath(), minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA, lastUsedInstallation: "install-from-backup" }))

    const { getConfig } = await freshConfigManager()
    const result = await getConfig()

    assert.equal(result.lastUsedInstallation, "install-from-backup")
    assert.equal(unreadableCopies().length, 1, "the unreadable file is still preserved even though the backup covered for it")

    const onDisk = await fse.readJSON(configPath())
    assert.equal(onDisk.lastUsedInstallation, "install-from-backup", "the restored document is saved as the new config.json")
  })

  it("falls back to defaults with no usable backup, and still keeps the copy", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")

    const { getConfig } = await freshConfigManager()
    const result = await getConfig()

    assert.deepEqual(result.installations, [], "nothing recoverable, so the defaults' empty state")
    assert.equal(result.defaultInstallationsFolder, join(appDataFolder, "RiftLauncherInstallations"))
    assert.equal(unreadableCopies().length, 1)
  })

  it("falls back to defaults when the pre-migration backup is itself unreadable, and still keeps the copy", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")
    writeFileSync(backupPath(), "{not valid json either,}", "utf-8")

    const { getConfig } = await freshConfigManager()
    const result = await getConfig()

    assert.deepEqual(result.installations, [])
    assert.equal(unreadableCopies().length, 1)
  })

  /**
   * `migrateConfigDocument` answers for every document without throwing, including ones it could not
   * bring to the current schema, so "the call returned" is not "the backup is a usable restore
   * point". A real pre-migration snapshot is older than the current schema and gets migrated up.
   */
  it("restores a backup from an older schema, which the migration brings up to date", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")
    const fse = (await import("fs-extra")).default
    await fse.writeJSON(backupPath(), minimalConfig({ schemaVersion: 2, lastUsedInstallation: "from-schema-2" }))

    const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
    const result = await getConfig()

    assert.equal(result.lastUsedInstallation, "from-schema-2")
    assert.equal(result.schemaVersion, CURRENT_CONFIG_SCHEMA)
    const [copy] = unreadableCopies()
    assert.ok(copy)
    assert.deepEqual(takePendingConfigRecoveryNotice(), { kind: "unreadable", restored: true, preserved: true, copyName: copy })
  })

  // Lazy bodies: minimalConfig reads the per-test temp folders, which only exist once beforeEach has run.
  const unusableBackups: ReadonlyArray<readonly [string, () => string]> = [
    ["an array, which is valid JSON but not a document", () => "[]"],
    ["from a newer launcher than this build", () => JSON.stringify(minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA + 1, lastUsedInstallation: "from-the-future" }))]
  ]

  for (const [description, backup] of unusableBackups) {
    it(`uses defaults and reports a reset, not a restore, when the pre-migration backup is ${description}`, async () => {
      writeFileSync(configPath(), INVALID_JSON, "utf-8")
      writeFileSync(backupPath(), backup(), "utf-8")

      const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
      const result = await getConfig()

      assert.equal(result.lastUsedInstallation, null, "none of the backup's settings were adopted")
      assert.equal(result.schemaVersion, CURRENT_CONFIG_SCHEMA)
      const [copy] = unreadableCopies()
      assert.ok(copy, "the unreadable file is still kept")
      assert.deepEqual(takePendingConfigRecoveryNotice(), { kind: "unreadable", restored: false, preserved: true, copyName: copy })
    })
  }

  it("keeps two copies when two launches in a row each find an unreadable config.json", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")
    const first = await freshConfigManager()
    await first.getConfig()
    assert.equal(unreadableCopies().length, 1)

    // The recovered config.json is valid now; corrupt it again the way a second bad hand edit would.
    writeFileSync(configPath(), INVALID_JSON, "utf-8")
    const second = await freshConfigManager()
    await second.getConfig()

    assert.equal(unreadableCopies().length, 2, "neither copy overwrote the other")
  })

  it("shares one preserve-and-recover pass between two concurrent first reads", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")

    const { getConfig } = await freshConfigManager()
    // Two callers racing the first read (the main window's ready-to-show handler and an early
    // renderer GET_CONFIG, say) before either has set the cache.
    const [first, second] = await Promise.all([getConfig(), getConfig()])

    assert.deepEqual(first, second, "both callers get the same recovered config")
    assert.equal(unreadableCopies().length, 1, "only one copy was preserved, not one per concurrent caller")
  })

  it("leaves a pending notice naming the copy, saying the previous settings were restored", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")
    const fse = (await import("fs-extra")).default
    await fse.writeJSON(backupPath(), minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA }))

    const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
    await getConfig()

    const [copy] = unreadableCopies()
    assert.ok(copy)
    assert.deepEqual(takePendingConfigRecoveryNotice(), { kind: "unreadable", restored: true, preserved: true, copyName: copy })
  })

  it("leaves a pending notice saying the previous settings could not be restored, with no backup", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")

    const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
    await getConfig()

    const [copy] = unreadableCopies()
    assert.ok(copy)
    assert.deepEqual(takePendingConfigRecoveryNotice(), { kind: "unreadable", restored: false, preserved: true, copyName: copy })
  })

  /**
   * With no usable backup, recovery used to hand back the shared module-level `defaultConfig`
   * object itself, so a caller mutating the config it got from getConfig() (saveCurrentWindowState
   * does exactly that) corrupted the cache every later call in the session would see.
   */
  it("returns a fresh defaults copy when recovering with no usable backup, not the shared module-level object", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")

    const { getConfig } = await freshConfigManager()
    const first = await getConfig()
    first.window.width = 4_242

    const second = await getConfig()
    assert.notEqual(second.window.width, 4_242, "the cached config was not the same object the first caller mutated")
  })

  // The renderer pulls the notice once through GET_CONFIG_RECOVERY_NOTICE rather than the main
  // process pushing it: a push can fire before React has mounted the provider that listens for it
  // (the first getConfig() is often main's own ready-to-show handler), and webContents.send does
  // not queue, so that message is just gone. Keeping the notice here until asked for survives
  // however late the renderer gets around to asking.
  it("clears the pending notice once it has been taken, so a second read of it is null", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")

    const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
    await getConfig()

    assert.notEqual(takePendingConfigRecoveryNotice(), null)
    assert.equal(takePendingConfigRecoveryNotice(), null)
  })

  it("has no pending notice on an ordinary, readable config", async () => {
    writeFileSync(configPath(), JSON.stringify(minimalConfig()), "utf-8")

    const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
    await getConfig()

    assert.equal(takePendingConfigRecoveryNotice(), null)
  })

  /**
   * Notepad and some other editors save UTF-8 with a byte order mark, which JSON.parse rejects.
   * The reader this one replaced (fs-extra's readJSON) stripped it, so a config that loaded before
   * must not start landing in recovery, where its settings would be set aside for a backup or
   * for defaults.
   */
  it("reads a valid config.json saved with a byte order mark as an ordinary config", async () => {
    const saved = `\uFEFF${JSON.stringify(minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA, lastUsedInstallation: "from-a-bom-file" }))}`
    writeFileSync(configPath(), saved, "utf-8")

    const { getConfig, takePendingConfigRecoveryNotice, isConfigWriteSuppressed } = await freshConfigManager()
    const result = await getConfig()

    assert.equal(result.lastUsedInstallation, "from-a-bom-file", "its own settings, not a backup's or the defaults'")
    assert.equal(unreadableCopies().length, 0, "nothing was copied aside: the file was never unreadable")
    assert.equal(takePendingConfigRecoveryNotice(), null, "no recovery notice")
    assert.equal(isConfigWriteSuppressed(), false, "the session is not read-only")
    assert.equal(readFileSync(configPath(), "utf-8"), saved, "the file on disk was not rewritten")
  })

  /**
   * The name-collision retry never actually ran: fs-extra 11's `copy` throws a plain `Error` with
   * no `code` when `errorOnExist` trips, so a `code === "EEXIST"` check never matched it, the retry
   * loop's catch fell straight through to the outer handler, and `config.json` still got overwritten
   * with nothing preserved. Reproduced here with a pinned clock, because without one the "two
   * launches in a row" coverage above only passes by accident: the real clock has moved on to a new
   * millisecond by the second call, so two different names are picked and no collision is ever hit.
   */
  it("still preserves a copy under a pinned clock when a same-named copy already exists", async () => {
    // Only Date is faked: scheduleConfigWrite's own debounce (setTimeout) still needs to run for
    // real, or saveConfig's queued write never resolves and the test hangs.
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      const collidingName = `config.unreadable-${stamp}.json`

      writeFileSync(configPath(), INVALID_JSON, "utf-8")
      writeFileSync(join(userDataFolder, collidingName), "someone else's file", "utf-8")

      const { getConfig } = await freshConfigManager()
      const result = await getConfig()

      // The original, invalid bytes are preserved under a second name; the pre-existing file at
      // the colliding name is left untouched, not overwritten with the invalid config.
      const copies = unreadableCopies()
      assert.equal(copies.length, 2)
      assert.equal(readFileSync(join(userDataFolder, collidingName), "utf-8"), "someone else's file")
      const secondCopy = copies.find((name) => name !== collidingName)
      assert.ok(secondCopy)
      assert.equal(readFileSync(join(userDataFolder, secondCopy), "utf-8"), INVALID_JSON)

      // And config.json itself was not silently replaced without a preserved original: the fixed
      // defaults are there because no backup existed, exactly like the uncontested case.
      assert.deepEqual(result.installations, [])
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * When preservation itself fails (every candidate name denied, the source vanished mid-copy,
   * whatever the cause), getConfig must not fall through to overwriting config.json anyway: that
   * is the exact loss #554 exists to prevent, just reached from a different door. The recovered
   * config runs for this session only, in memory, and nothing is written to disk.
   */
  it("does not overwrite config.json when preserving a copy fails", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")

    const { getConfig } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "copyFile").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }))

    const result = await getConfig()

    assert.deepEqual(result.installations, [], "the recovered config is still handed back for this session")
    assert.equal(unreadableCopies().length, 0, "nothing was preserved")
    assert.equal(readFileSync(configPath(), "utf-8"), INVALID_JSON, "the original file on disk is untouched, not replaced by the recovered defaults")
  })

  it("suppresses every later write for the rest of the session once preservation fails", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")

    const { getConfig, saveConfig, isConfigWriteSuppressed } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "copyFile").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }))

    const recovered = await getConfig()
    assert.equal(isConfigWriteSuppressed(), true)

    // The follow-up writes #554's fix still missed: a window-state save (saveCurrentWindowState in
    // src/main/index.ts) and the renderer's own settings save both call saveConfig directly with
    // whatever config they were handed, same as this.
    const windowStateSave = await saveConfig({ ...recovered, window: { ...recovered.window, width: 1_600 } })
    assert.equal(windowStateSave, false)
    assert.equal(readFileSync(configPath(), "utf-8"), INVALID_JSON, "a window-state save after the failed preservation did not overwrite the original file")

    const settingsSave = await saveConfig({ ...recovered, lastUsedInstallation: "picked-in-renderer" })
    assert.equal(settingsSave, false)
    assert.equal(readFileSync(configPath(), "utf-8"), INVALID_JSON, "a renderer settings save after the failed preservation did not overwrite the original file either")
  })

  it("still leaves an honest pending notice when preservation fails", async () => {
    writeFileSync(configPath(), INVALID_JSON, "utf-8")

    const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "copyFile").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }))

    await getConfig()

    assert.deepEqual(takePendingConfigRecoveryNotice(), { kind: "unreadable", restored: false, preserved: false, copyName: null })
  })

  /**
   * A failure reading config.json itself (permissions, a Windows sharing lock, ...) says nothing
   * about whether the document inside is valid. Treating it the same as a parse failure would
   * preserve-and-recover a config that may be perfectly fine, and the copy step would fail for the
   * very same reason the read did, landing right back in the same trap as the case above. Instead
   * this session runs on defaults in memory, and neither preserves nor overwrites anything.
   */
  it("does not preserve or overwrite the file when reading it fails for a reason other than bad content", async () => {
    writeFileSync(configPath(), JSON.stringify(minimalConfig({ lastUsedInstallation: "still-here" })), "utf-8")

    const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "readFile").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }))

    const result = await getConfig()

    assert.deepEqual(result.installations, [], "runs on defaults in memory rather than throwing")
    assert.equal(unreadableCopies().length, 0, "the file was never touched, so there is nothing to preserve")
    assert.equal(JSON.parse(readFileSync(configPath(), "utf-8")).lastUsedInstallation, "still-here", "the perfectly valid file on disk was never overwritten")
    // Unlike the #554 parse-failure cases, nothing here says the document itself is bad, so this
    // gets its own honest notice rather than the "unreadable JSON" wording, and rather than staying
    // silent the way an earlier version of this fix did.
    assert.deepEqual(takePendingConfigRecoveryNotice(), { kind: "read-failed" })
  })

  it("returns a fresh defaults copy on a read failure, not the shared module-level object", async () => {
    writeFileSync(configPath(), JSON.stringify(minimalConfig({ lastUsedInstallation: "still-here" })), "utf-8")

    const { getConfig } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "readFile").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }))

    const first = await getConfig()
    // saveCurrentWindowState (src/main/index.ts) mutates the config it gets back from getConfig()
    // in place before saving it; if getConfig ever handed out the same defaults object twice, this
    // mutation would leak into the next caller.
    first.window.width = 9_999

    const second = await getConfig()
    assert.notEqual(second.window.width, 9_999, "the second call's defaults were not corrupted by the first call's mutation")
  })

  it("suppresses every later write for the rest of the session once a read fails on the retry too", async () => {
    writeFileSync(configPath(), JSON.stringify(minimalConfig({ lastUsedInstallation: "still-here" })), "utf-8")

    const { getConfig, saveConfig, isConfigWriteSuppressed } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    // Persistent, not just-once: a single blip is now retried (see the retry tests below), so
    // suppression for the rest of the session only kicks in once the retry fails too.
    vi.spyOn(fse, "readFile").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }))

    const config = await getConfig()
    assert.equal(isConfigWriteSuppressed(), true)

    // The next real writer in line: a window move, or the renderer's own settings save. Both call
    // saveConfig with whatever config they were handed, same as this.
    const saved = await saveConfig({ ...config, lastUsedInstallation: "changed-in-memory" })

    assert.equal(saved, false, "saveConfig reports the write did not happen")
    assert.equal(JSON.parse(readFileSync(configPath(), "utf-8")).lastUsedInstallation, "still-here", "config.json on disk is untouched")
  })

  it("logs the refused-write warning once per session, not on every refused save", async () => {
    writeFileSync(configPath(), JSON.stringify(minimalConfig({ lastUsedInstallation: "still-here" })), "utf-8")

    const { getConfig, saveConfig } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    vi.spyOn(fse, "readFile").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }))
    const logSpy = vi.spyOn(await import("@src/utils/logManager"), "logMessage")

    const config = await getConfig()
    await saveConfig({ ...config, lastUsedInstallation: "a" })
    await saveConfig({ ...config, lastUsedInstallation: "b" })
    await saveConfig({ ...config, lastUsedInstallation: "c" })

    const refusalWarnings = logSpy.mock.calls.filter(([, message]) => message.includes("Refusing to write config.json"))
    assert.equal(refusalWarnings.length, 1, "three refused saves, one warning")
  })

  /**
   * A failed read gets one retry after a short delay before this session gives up on the file: most
   * failures here are a transient lock (a brief antivirus scan, a Windows sharing lock, an EBUSY),
   * and treating the first attempt as final turns a blip into a whole read-only session.
   */
  it("retries a failed read once and uses the real settings when the retry succeeds", async () => {
    // Already at the current schema, so a successful read never triggers a migration save: what
    // this test needs to isolate is the retry itself, not the ordinary post-migration write.
    const onDisk = minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA, lastUsedInstallation: "real-settings" })
    writeFileSync(configPath(), JSON.stringify(onDisk), "utf-8")

    const { getConfig, takePendingConfigRecoveryNotice, isConfigWriteSuppressed } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    const realReadFile = fse.readFile.bind(fse)
    vi.spyOn(fse, "readFile")
      .mockRejectedValueOnce(Object.assign(new Error("resource busy"), { code: "EBUSY" }))
      .mockImplementation(realReadFile)

    const result = await getConfig()

    assert.equal(result.lastUsedInstallation, "real-settings", "the retry's real read won, not defaults")
    assert.equal(takePendingConfigRecoveryNotice(), null, "a transient blip that recovered on retry raises no notice")
    assert.equal(isConfigWriteSuppressed(), false, "not read-only: the retry succeeded")
    assert.equal(readFileSync(configPath(), "utf-8"), JSON.stringify(onDisk), "the file on disk was never touched")
  }, 10_000)

  /**
   * When the retry fails too, the fresh defaults are cached for the session so later getConfig()
   * calls do not go back to the disk, do not re-log the failure, and do not re-arm the notice.
   */
  it("caches fresh defaults after a persistent read failure so later getConfig calls do not re-read or re-raise the notice", async () => {
    writeFileSync(configPath(), JSON.stringify(minimalConfig({ lastUsedInstallation: "still-here" })), "utf-8")

    const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
    const fse = (await import("fs-extra")).default
    const readFileSpy = vi.spyOn(fse, "readFile").mockRejectedValue(Object.assign(new Error("resource busy"), { code: "EBUSY" }))

    await getConfig()

    assert.equal(readFileSpy.mock.calls.length, 2, "the initial attempt plus exactly one retry")
    assert.deepEqual(takePendingConfigRecoveryNotice(), { kind: "read-failed" }, "one notice after the first call")

    // Several later calls, no cache primed yet from a save: none of them should touch the disk again.
    await getConfig()
    await getConfig()

    assert.equal(readFileSpy.mock.calls.length, 2, "later getConfig calls used the cached defaults instead of re-reading")
    assert.equal(takePendingConfigRecoveryNotice(), null, "a second pull after the first getConfig call already found nothing left")
    assert.equal(readFileSync(configPath(), "utf-8"), JSON.stringify(minimalConfig({ lastUsedInstallation: "still-here" })), "the file on disk was never touched")
  }, 10_000)

  /**
   * `[]`, `null`, a bare number or string: all valid JSON, none of them a config document.
   * `migrateConfigDocument` used to read these as `outcome: "unreadable"` and let normalizeConfig
   * quietly build defaults, with no copy taken and no migration ever running to trigger a save, so
   * the loss only showed up whenever something later did save. Same failure class as a syntax
   * error, so it now goes through the same preserve-and-recover door.
   */
  it("preserves and recovers valid JSON that is not an object, the same as invalid JSON", async () => {
    writeFileSync(configPath(), "[]", "utf-8")

    const { getConfig, takePendingConfigRecoveryNotice } = await freshConfigManager()
    const result = await getConfig()

    assert.deepEqual(result.installations, [])
    assert.equal(unreadableCopies().length, 1)
    assert.equal(readFileSync(join(userDataFolder, unreadableCopies()[0]!), "utf-8"), "[]")
    const notice = takePendingConfigRecoveryNotice()
    assert.ok(notice)
    if (notice.kind !== "unreadable") throw new Error(`expected an "unreadable" notice, got ${notice.kind}`)
    assert.equal(notice.preserved, true)
  })

  for (const notAnObject of ["null", "42", '"a string"']) {
    it(`preserves and recovers ${notAnObject} the same way`, async () => {
      writeFileSync(configPath(), notAnObject, "utf-8")
      const { getConfig } = await freshConfigManager()
      await getConfig()
      assert.equal(unreadableCopies().length, 1, notAnObject)
    })
  }
})

/**
 * A login on a machine with no keyring keeps its session in the main process and writes no
 * secrets (#481). The public half still has to reach `config.accounts`, because that list is
 * where EXECUTE_GAME looks the active account up, so the account carries a mark saying it lasts
 * as long as the process does. Startup is where the mark is acted on: the next launch has no
 * secrets for it, and an account that cannot launch and says nothing about why is worse than no
 * account at all.
 */
describe("normalizeConfig: an account kept for this run only (#481)", () => {
  const sessionOnlyAccount = { email: "player@example.com", playerName: "Player", playerUid: "uid-1", playerEntitlements: null, hostGameServer: false, sessionOnly: true } as const
  const savedAccount = { email: "other@example.com", playerName: "Other", playerUid: "uid-2", playerEntitlements: null, hostGameServer: false } as const

  it("keeps it in this process, where the game launch can still find it", async () => {
    const { getConfig, saveConfig } = await freshConfigManager()
    await getConfig()
    assert.equal(await saveConfig(minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA, accounts: [sessionOnlyAccount], activeAccountId: "uid-1" })), true)

    const config = await getConfig()
    // The lookup EXECUTE_GAME itself does, in src/ipc/handlers/gameHandlers.ts.
    assert.deepEqual(
      config.accounts.find((candidate) => candidate.playerUid === config.activeAccountId),
      sessionOnlyAccount
    )
  })

  it("is gone at the next startup, and the choice of account falls back to one that can still launch", async () => {
    const { getConfig, saveConfig } = await freshConfigManager()
    await getConfig()
    await saveConfig(minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA, accounts: [savedAccount, sessionOnlyAccount], activeAccountId: "uid-1" }))

    const restarted = await freshConfigManager()
    const config = await restarted.getConfig()

    assert.deepEqual(config.accounts, [savedAccount])
    assert.equal(config.activeAccountId, "uid-2")
  })

  it("leaves an ordinary saved account alone across the same restart", async () => {
    const { getConfig, saveConfig } = await freshConfigManager()
    await getConfig()
    await saveConfig(minimalConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA, accounts: [savedAccount], activeAccountId: "uid-2" }))

    const restarted = await freshConfigManager()
    const config = await restarted.getConfig()

    assert.deepEqual(config.accounts, [savedAccount])
    assert.equal(config.activeAccountId, "uid-2")
  })

  it("only reads a literal true as the mark, so no hand-edited spelling can delete a saved account", async () => {
    const { normalizeConfig } = await freshConfigManager()

    for (const spelling of ["true", 1, "1", "yes", false, null, {}]) {
      const config = normalizeConfig({ accounts: [{ ...savedAccount, sessionOnly: spelling }] })
      assert.deepEqual(config.accounts, [savedAccount], `sessionOnly: ${JSON.stringify(spelling)}`)
    }
  })
})
