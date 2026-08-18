import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  clampConfigSchema,
  CONFIG_MIGRATIONS,
  CURRENT_CONFIG_SCHEMA,
  detectConfigSchema,
  FIRST_INTEGER_CONFIG_SCHEMA,
  FLOAT_ERA_CONFIG_SCHEMA,
  floatMarkerToIntegerSchema,
  MAX_CONFIG_SCHEMA,
  migrateConfigDocument,
  stampLinkedOnExternalVersions
} from "../../../src/domain/config/migrations"
import type { ConfigMigration } from "../../../src/domain/config/migrations"

/** A config as the last float-era build wrote it, trimmed to the fields that matter here. */
function floatEraConfig(): Record<string, unknown> {
  return {
    version: 1.6,
    lastUsedInstallation: "abc",
    defaultInstallationsFolder: "/home/user/VSLInstallations",
    window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
    installations: [{ id: "abc", path: "/home/user/VSLInstallations/abc" }],
    favMods: [12]
  }
}

describe("detectConfigSchema", () => {
  it("reads today's float marker as the float era", () => {
    assert.deepEqual(detectConfigSchema(floatEraConfig()), { era: "float", schema: FLOAT_ERA_CONFIG_SCHEMA })
  })

  it("reads a hypothetical 1.10 as the float era too, without ordering it against 1.6", () => {
    assert.deepEqual(detectConfigSchema({ version: 1.1 }), { era: "float", schema: FLOAT_ERA_CONFIG_SCHEMA })
  })

  it("reads a config with no marker at all as the float era", () => {
    assert.deepEqual(detectConfigSchema({ installations: [] }), { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA })
  })

  it("reads an integer marker as the schema it says", () => {
    assert.deepEqual(detectConfigSchema({ schemaVersion: 2 }), { era: "integer", schema: 2 })
    assert.deepEqual(detectConfigSchema({ schemaVersion: 7 }), { era: "integer", schema: 7 })
    assert.deepEqual(detectConfigSchema({ schemaVersion: MAX_CONFIG_SCHEMA }), { era: "integer", schema: MAX_CONFIG_SCHEMA })
  })

  it("prefers the integer marker over a leftover float one", () => {
    assert.deepEqual(detectConfigSchema({ schemaVersion: 3, version: 1.6 }), { era: "integer", schema: 3 })
  })

  it("refuses a schemaVersion that is not an integer-era marker and falls back", () => {
    assert.deepEqual(detectConfigSchema({ schemaVersion: 1.6 }), { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA })
    assert.deepEqual(detectConfigSchema({ schemaVersion: 1 }), { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA })
    assert.deepEqual(detectConfigSchema({ schemaVersion: -4 }), { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA })
    assert.deepEqual(detectConfigSchema({ schemaVersion: MAX_CONFIG_SCHEMA + 1 }), { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA })
    assert.deepEqual(detectConfigSchema({ schemaVersion: Number.NaN }), { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA })
    assert.deepEqual(detectConfigSchema({ schemaVersion: "2" }), { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA })
    assert.deepEqual(detectConfigSchema({ schemaVersion: "2", version: 1.4 }), { era: "float", schema: FLOAT_ERA_CONFIG_SCHEMA })
  })

  it("refuses a version field that is not a number", () => {
    assert.deepEqual(detectConfigSchema({ version: "1.6" }), { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA })
    assert.deepEqual(detectConfigSchema({ version: Number.POSITIVE_INFINITY }), { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA })
  })

  it("has nothing to read in something that is not an object", () => {
    for (const value of [null, undefined, 42, "config", [1, 2], [{ version: 1.6 }]]) {
      assert.deepEqual(detectConfigSchema(value), { era: "unreadable", schema: null })
    }
  })
})

describe("clampConfigSchema", () => {
  it("keeps an integer in range", () => {
    assert.equal(clampConfigSchema(FIRST_INTEGER_CONFIG_SCHEMA), FIRST_INTEGER_CONFIG_SCHEMA)
    assert.equal(clampConfigSchema(MAX_CONFIG_SCHEMA), MAX_CONFIG_SCHEMA)
  })

  it("keeps a schema from a newer build rather than quietly rewriting it", () => {
    assert.equal(clampConfigSchema(7), 7)
  })

  it("truncates a float down to the integer it is at least", () => {
    assert.equal(clampConfigSchema(3.9), 3)
  })

  it("falls back to the current schema for anything out of range or not a number", () => {
    for (const value of [1.6, 1, 0, -2, MAX_CONFIG_SCHEMA + 1, Number.NaN, Number.POSITIVE_INFINITY, "2", null, undefined, {}]) {
      assert.equal(clampConfigSchema(value), CURRENT_CONFIG_SCHEMA)
    }
  })
})

describe("floatMarkerToIntegerSchema", () => {
  it("steps from the float era to the first integer schema", () => {
    assert.equal(floatMarkerToIntegerSchema.fromSchema, FLOAT_ERA_CONFIG_SCHEMA)
    assert.equal(floatMarkerToIntegerSchema.toSchema, FIRST_INTEGER_CONFIG_SCHEMA)
  })

  it("drops the float marker and moves nothing else", () => {
    const before = floatEraConfig()
    const after = floatMarkerToIntegerSchema.migrate(before)

    assert.deepEqual(after, {
      lastUsedInstallation: "abc",
      defaultInstallationsFolder: "/home/user/VSLInstallations",
      window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
      installations: [{ id: "abc", path: "/home/user/VSLInstallations/abc" }],
      favMods: [12]
    })
  })

  it("leaves the schema marker to the runner", () => {
    assert.equal((floatMarkerToIntegerSchema.migrate(floatEraConfig()) as Record<string, unknown>).schemaVersion, undefined)
  })

  it("handles a document that never had the field", () => {
    assert.deepEqual(floatMarkerToIntegerSchema.migrate({ installations: [] }), { installations: [] })
    assert.deepEqual(floatMarkerToIntegerSchema.migrate({}), {})
  })

  it("does not mutate the document it is given", () => {
    const before = floatEraConfig()
    floatMarkerToIntegerSchema.migrate(before)
    assert.equal(before.version, 1.6)
  })

  it("hands back anything that is not an object untouched", () => {
    assert.equal(floatMarkerToIntegerSchema.migrate(null), null)
    assert.equal(floatMarkerToIntegerSchema.migrate("config"), "config")
  })
})

describe("migrateConfigDocument on real configs", () => {
  it("brings today's 1.6 config to the current schema", () => {
    const before = floatEraConfig()
    const result = migrateConfigDocument(before)

    assert.equal(result.outcome, "migrated")
    assert.equal(result.schema, CURRENT_CONFIG_SCHEMA)
    assert.deepEqual(result.detected, { era: "float", schema: FLOAT_ERA_CONFIG_SCHEMA })
    assert.deepEqual(result.applied, [
      { fromSchema: 1, toSchema: 2 },
      { fromSchema: 2, toSchema: 3 }
    ])

    const doc = result.doc as Record<string, unknown>
    assert.equal(doc.schemaVersion, CURRENT_CONFIG_SCHEMA)
    assert.equal("version" in doc, false)
    assert.equal(doc.lastUsedInstallation, "abc")
    assert.deepEqual(doc.favMods, [12])
  })

  it("brings a versionless config to the current schema the same way", () => {
    const result = migrateConfigDocument({ installations: [], favMods: [] })

    assert.equal(result.outcome, "migrated")
    assert.equal(result.detected.era, "absent")
    const doc = result.doc as Record<string, unknown>
    assert.equal(doc.schemaVersion, CURRENT_CONFIG_SCHEMA)
    assert.deepEqual(doc.installations, [])
    assert.deepEqual(doc.favMods, [])
  })

  it("leaves a config already at the current schema alone", () => {
    const before = { schemaVersion: CURRENT_CONFIG_SCHEMA, favMods: [1] }
    const result = migrateConfigDocument(before)

    assert.equal(result.outcome, "already-current")
    assert.deepEqual(result.applied, [])
    assert.equal(result.doc, before)
  })

  it("never downgrades a config from a newer build", () => {
    const before = { schemaVersion: 7, somethingThisBuildNeverHeardOf: true }
    const result = migrateConfigDocument(before)

    assert.equal(result.outcome, "future-schema")
    assert.equal(result.schema, 7)
    assert.deepEqual(result.applied, [])
    assert.equal(result.doc, before)
  })

  it("hands garbage straight back for the normalizer to deal with", () => {
    for (const value of [null, undefined, "config.json", 7, ["version", 1.6]]) {
      const result = migrateConfigDocument(value)
      assert.equal(result.outcome, "unreadable")
      assert.equal(result.schema, null)
      assert.deepEqual(result.applied, [])
      assert.deepEqual(result.doc, value)
    }
  })

  it("does not mutate the document it is given", () => {
    const before = floatEraConfig()
    migrateConfigDocument(before)
    assert.equal(before.version, 1.6)
    assert.equal("schemaVersion" in before, false)
  })

  it("ships exactly the migrations the current schema needs, in order", () => {
    assert.deepEqual(
      CONFIG_MIGRATIONS.map((migration) => [migration.fromSchema, migration.toSchema]),
      [
        [FLOAT_ERA_CONFIG_SCHEMA, FIRST_INTEGER_CONFIG_SCHEMA],
        [2, 3]
      ]
    )
    assert.equal(CONFIG_MIGRATIONS[CONFIG_MIGRATIONS.length - 1]?.toSchema, CURRENT_CONFIG_SCHEMA)
  })
})

describe("stampLinkedOnExternalVersions", () => {
  it("steps from schema 2 to 3", () => {
    assert.equal(stampLinkedOnExternalVersions.fromSchema, 2)
    assert.equal(stampLinkedOnExternalVersions.toSchema, 3)
  })

  it("stamps linked on versions outside the managed folder", () => {
    const doc = {
      defaultVersionsFolder: "/home/user/VSLGameVersions",
      gameVersions: [
        { version: "1.20.0", path: "/home/user/VSLGameVersions/1.20.0" },
        { version: "1.19.0", path: "/opt/games/vintagestory" }
      ]
    }
    const result = stampLinkedOnExternalVersions.migrate(doc) as Record<string, unknown>
    const versions = result.gameVersions as Array<Record<string, unknown>>

    assert.equal(versions[0]!.linked, undefined)
    assert.equal(versions[1]!.linked, true)
  })

  it("leaves versions already marked linked alone", () => {
    const doc = {
      defaultVersionsFolder: "/home/user/VSLGameVersions",
      gameVersions: [{ version: "1.19.0", path: "/opt/games/vs", linked: true }]
    }
    const result = stampLinkedOnExternalVersions.migrate(doc) as Record<string, unknown>
    const versions = result.gameVersions as Array<Record<string, unknown>>

    assert.equal(versions[0]!.linked, true)
  })

  it("treats all versions as external when defaultVersionsFolder is missing", () => {
    const doc = {
      gameVersions: [
        { version: "1.20.0", path: "/home/user/VSLGameVersions/1.20.0" },
        { version: "1.19.0", path: "/opt/games/vs" }
      ]
    }
    const result = stampLinkedOnExternalVersions.migrate(doc) as Record<string, unknown>
    const versions = result.gameVersions as Array<Record<string, unknown>>

    assert.equal(versions[0]!.linked, true)
    assert.equal(versions[1]!.linked, true)
  })

  it("handles an empty gameVersions array", () => {
    const doc = { defaultVersionsFolder: "/x", gameVersions: [] }
    const result = stampLinkedOnExternalVersions.migrate(doc) as Record<string, unknown>
    assert.deepEqual(result, { defaultVersionsFolder: "/x", gameVersions: [] })
  })

  it("handles a document with no gameVersions at all", () => {
    const doc = { defaultVersionsFolder: "/x", installations: [] }
    const result = stampLinkedOnExternalVersions.migrate(doc) as Record<string, unknown>
    assert.deepEqual(result.installations, [])
  })

  it("does not mutate the input document", () => {
    const version = { version: "1.19.0", path: "/opt/games/vs" }
    const doc = { defaultVersionsFolder: "/managed", gameVersions: [version] }
    stampLinkedOnExternalVersions.migrate(doc)
    assert.equal("linked" in version, false)
  })

  it("hands back non-objects untouched", () => {
    assert.equal(stampLinkedOnExternalVersions.migrate(null), null)
    assert.equal(stampLinkedOnExternalVersions.migrate("config"), "config")
  })
})

/** Steps that only mark themselves, so the runner's own behavior is what the assertions see. */
function markerStep(fromSchema: number): ConfigMigration {
  return {
    fromSchema,
    toSchema: fromSchema + 1,
    migrate: (doc: unknown): unknown => ({ ...(doc as Record<string, unknown>), [`ran${fromSchema}`]: true })
  }
}

describe("migrateConfigDocument chaining", () => {
  it("runs several steps in order and stamps the schema after each", () => {
    const result = migrateConfigDocument({ schemaVersion: 2 }, { migrations: [markerStep(3), markerStep(2), markerStep(4)], targetSchema: 5 })

    assert.equal(result.outcome, "migrated")
    assert.equal(result.schema, 5)
    assert.deepEqual(result.applied, [
      { fromSchema: 2, toSchema: 3 },
      { fromSchema: 3, toSchema: 4 },
      { fromSchema: 4, toSchema: 5 }
    ])
    assert.deepEqual(result.doc, { schemaVersion: 5, ran2: true, ran3: true, ran4: true })
  })

  it("stops where the chain runs out instead of throwing", () => {
    const result = migrateConfigDocument({ schemaVersion: 2 }, { migrations: [markerStep(2), markerStep(4)], targetSchema: 5 })

    assert.equal(result.outcome, "chain-broken")
    assert.equal(result.schema, 3)
    assert.deepEqual(result.applied, [{ fromSchema: 2, toSchema: 3 }])
    assert.deepEqual(result.doc, { schemaVersion: 3, ran2: true })
  })

  it("stops on a step that does not advance the schema", () => {
    const stuck: ConfigMigration = { fromSchema: 2, toSchema: 2, migrate: (doc: unknown): unknown => doc }
    const result = migrateConfigDocument({ schemaVersion: 2 }, { migrations: [stuck], targetSchema: 3 })

    assert.equal(result.outcome, "chain-broken")
    assert.deepEqual(result.applied, [])
  })

  it("stops before a step that throws, keeping what the earlier steps produced", () => {
    const broken: ConfigMigration = {
      fromSchema: 3,
      toSchema: 4,
      migrate: (): unknown => {
        throw new Error("bad migration")
      }
    }
    const result = migrateConfigDocument({ schemaVersion: 2 }, { migrations: [markerStep(2), broken], targetSchema: 4 })

    assert.equal(result.outcome, "migration-failed")
    assert.equal(result.schema, 3)
    assert.deepEqual(result.doc, { schemaVersion: 3, ran2: true })
  })

  it("stops on a step that returns something that is not a document", () => {
    const wrong: ConfigMigration = { fromSchema: 2, toSchema: 3, migrate: (): unknown => null }
    const result = migrateConfigDocument({ schemaVersion: 2 }, { migrations: [wrong], targetSchema: 3 })

    assert.equal(result.outcome, "migration-failed")
    assert.deepEqual(result.doc, { schemaVersion: 2 })
    assert.deepEqual(result.applied, [])
  })

  it("has nothing to do when the target is behind an empty migration list", () => {
    const result = migrateConfigDocument({ schemaVersion: 2 }, { migrations: [], targetSchema: 2 })
    assert.equal(result.outcome, "already-current")
  })
})
