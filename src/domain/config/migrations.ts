/**
 * Brings a stored config document up to the schema the launcher reads today.
 *
 * The config file used to carry `version: 1.6`, a float, and that float was
 * documented as a map onto app versions. Both facts were traps. A float marker
 * orders wrong the moment a schema 1.10 exists, because 1.10 < 1.6, and a
 * marker tied to the app version cannot move when the shape of the file moves
 * without the app moving with it. The stored marker is now `schemaVersion`, an
 * integer, and it counts schemas and nothing else.
 *
 * Everything here is pure: a document in, a document out, no file system, no
 * Electron, no logging. The host reads the JSON, runs it through
 * {@link migrateConfigDocument}, then hands the result to `normalizeConfig`,
 * which stays the last line of defense. That order matters. Migrations move
 * shape between known schemas; the normalizer clamps every field whatever the
 * schema turned out to be. Neither one throws, so a config file can be as
 * strange as it likes and the launcher still starts.
 */

/** Schema every config the launcher writes today carries. */
export const CURRENT_CONFIG_SCHEMA = 2

/**
 * First schema expressed as an integer.
 *
 * A `schemaVersion` below this is not an integer-era marker, whatever it says,
 * and the document falls back to the float-era reading.
 */
export const FIRST_INTEGER_CONFIG_SCHEMA = 2

/**
 * Schema every float-era document is read as.
 *
 * The float era ran from 1.0 to 1.6 and never had a migration pipeline: the
 * shape differences between those releases were absorbed by the tolerant
 * normalizer, field by field. So they collapse onto one schema rather than
 * six, and that schema is what "anything the float era wrote" means.
 */
export const FLOAT_ERA_CONFIG_SCHEMA = 1

/** Highest marker worth keeping. Anything above is noise, not a schema. */
export const MAX_CONFIG_SCHEMA = 99

/** Which marker a stored document turned out to carry. */
export type ConfigSchemaEra =
  /** A usable `schemaVersion` integer. */
  | "integer"
  /** No usable `schemaVersion`, but the float-era `version` field is there. */
  | "float"
  /** A document with neither marker, from before either existed or hand-edited. */
  | "absent"
  /** Not an object at all: a JSON array, a string, null. */
  | "unreadable"

export interface DetectedConfigSchema {
  readonly era: ConfigSchemaEra
  /** Schema the document is read as, or null when there is no document to read. */
  readonly schema: number | null
}

/**
 * One step of the pipeline: takes a document at {@link fromSchema} and returns
 * it shaped for {@link toSchema}.
 *
 * A migration never touches `schemaVersion`. The runner stamps it after the
 * step returns, so a migration only ever has to think about shape. A migration
 * must not mutate the document it is given.
 */
export interface ConfigMigration {
  readonly fromSchema: number
  readonly toSchema: number
  migrate(doc: unknown): unknown
}

/** One step the runner actually ran, in the order it ran. */
export interface AppliedConfigMigration {
  readonly fromSchema: number
  readonly toSchema: number
}

/** How a run ended. Each value is a distinct thing for the host to log. */
export type ConfigMigrationOutcome =
  /** Nothing object-shaped to migrate. The normalizer will build a default config. */
  | "unreadable"
  /** The document was already at the target schema. */
  | "already-current"
  /** At least one migration ran and the document reached the target schema. */
  | "migrated"
  /** The document comes from a newer launcher. Left untouched, never downgraded. */
  | "future-schema"
  /** No registered migration continues the chain. The document stops where it got to. */
  | "chain-broken"
  /** A migration threw or returned something unusable. The document stops before that step. */
  | "migration-failed"

export interface ConfigMigrationResult {
  /** The document to hand to the normalizer. */
  readonly doc: unknown
  readonly detected: DetectedConfigSchema
  /** Schema the returned document is at, or null when there was nothing to read. */
  readonly schema: number | null
  readonly applied: readonly AppliedConfigMigration[]
  readonly outcome: ConfigMigrationOutcome
}

export interface ConfigMigrationOptions {
  /** Steps available to the runner. Defaults to {@link CONFIG_MIGRATIONS}. */
  readonly migrations?: readonly ConfigMigration[]
  /** Schema to reach. Defaults to {@link CURRENT_CONFIG_SCHEMA}. */
  readonly targetSchema?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Reads the schema a stored document is at.
 *
 * The rule, in order:
 *
 * 1. Not an object: nothing to read, `unreadable`.
 * 2. `schemaVersion` is an integer of at least {@link FIRST_INTEGER_CONFIG_SCHEMA}
 *    and at most {@link MAX_CONFIG_SCHEMA}: that is the schema. A float, a
 *    negative, a 1, a NaN or a string in that field is not an integer-era
 *    marker and falls through.
 * 3. A finite numeric `version`: the float era, read as
 *    {@link FLOAT_ERA_CONFIG_SCHEMA}. This is where today's `1.6` lands, and
 *    equally a `1.10` written by a fork.
 * 4. Neither: `absent`, also read as {@link FLOAT_ERA_CONFIG_SCHEMA}, because
 *    the oldest shape the launcher ever wrote is the safest assumption for a
 *    document that will not say.
 */
export function detectConfigSchema(doc: unknown): DetectedConfigSchema {
  if (!isRecord(doc)) return { era: "unreadable", schema: null }

  const marker = doc.schemaVersion
  if (typeof marker === "number" && Number.isSafeInteger(marker) && marker >= FIRST_INTEGER_CONFIG_SCHEMA && marker <= MAX_CONFIG_SCHEMA) {
    return { era: "integer", schema: marker }
  }

  if (typeof doc.version === "number" && Number.isFinite(doc.version)) return { era: "float", schema: FLOAT_ERA_CONFIG_SCHEMA }

  return { era: "absent", schema: FLOAT_ERA_CONFIG_SCHEMA }
}

/**
 * Clamps a stored `schemaVersion` down to something the launcher will keep.
 *
 * Used by the normalizer, after the pipeline, so the field is an integer in
 * range whatever happened upstream. A schema from a newer launcher survives
 * this on purpose: overwriting it would quietly destroy the marker of a user
 * who ran a newer build once and came back.
 */
export function clampConfigSchema(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CURRENT_CONFIG_SCHEMA

  const truncated = Math.trunc(value)
  return truncated >= FIRST_INTEGER_CONFIG_SCHEMA && truncated <= MAX_CONFIG_SCHEMA ? truncated : CURRENT_CONFIG_SCHEMA
}

/**
 * Float marker to integer marker, and nothing else.
 *
 * Deliberately boring: it drops the old `version` field and lets the runner
 * stamp `schemaVersion`. No other field moves, so a document that survived the
 * float era arrives at schema 2 byte for byte apart from its marker. A
 * document with no marker at all goes through the same step and comes out the
 * same way, which is what makes a versionless config land somewhere
 * deterministic instead of being guessed at.
 */
export const floatMarkerToIntegerSchema: ConfigMigration = {
  fromSchema: FLOAT_ERA_CONFIG_SCHEMA,
  toSchema: FIRST_INTEGER_CONFIG_SCHEMA,
  migrate(doc: unknown): unknown {
    if (!isRecord(doc)) return doc

    const migrated = { ...doc }
    delete migrated.version
    return migrated
  }
}

/** Every migration the launcher knows, lowest schema first. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [floatMarkerToIntegerSchema]

function byFromSchema(migrations: readonly ConfigMigration[]): Map<number, ConfigMigration> {
  return new Map(migrations.map((migration) => [migration.fromSchema, migration]))
}

/**
 * Runs the pipeline over a stored document.
 *
 * Detects the incoming schema, applies the registered migrations in order
 * until the target is reached, and stamps `schemaVersion` after each step.
 * Every way this can go wrong ends in a returned result, never an exception:
 * a document from a newer launcher passes through untouched, a broken chain or
 * a throwing migration stops the document where it got to, and anything that
 * is not an object comes straight back out. The normalizer downstream turns
 * whatever this returns into a usable config.
 *
 * @param doc Parsed config document, exactly as it came off disk.
 * @param options Migrations to use and schema to reach. Both default to the
 *   production values; tests and future callers can substitute their own.
 * @returns The document, the schema it is now at, and what ran to get there.
 */
export function migrateConfigDocument(doc: unknown, options: ConfigMigrationOptions = {}): ConfigMigrationResult {
  const migrations = options.migrations ?? CONFIG_MIGRATIONS
  const targetSchema = options.targetSchema ?? CURRENT_CONFIG_SCHEMA

  const detected = detectConfigSchema(doc)
  if (detected.schema === null) return { doc, detected, schema: null, applied: [], outcome: "unreadable" }
  if (detected.schema > targetSchema) return { doc, detected, schema: detected.schema, applied: [], outcome: "future-schema" }
  if (detected.schema === targetSchema) return { doc, detected, schema: detected.schema, applied: [], outcome: "already-current" }

  const available = byFromSchema(migrations)
  const applied: AppliedConfigMigration[] = []
  let current: unknown = doc
  let schema = detected.schema

  while (schema < targetSchema) {
    const migration = available.get(schema)
    if (!migration || migration.toSchema <= schema) {
      return { doc: current, detected, schema, applied, outcome: "chain-broken" }
    }

    let stepped: unknown
    try {
      stepped = migration.migrate(current)
    } catch {
      return { doc: current, detected, schema, applied, outcome: "migration-failed" }
    }

    if (!isRecord(stepped)) return { doc: current, detected, schema, applied, outcome: "migration-failed" }

    current = { ...stepped, schemaVersion: migration.toSchema }
    schema = migration.toSchema
    applied.push({ fromSchema: migration.fromSchema, toSchema: migration.toSchema })
  }

  return { doc: current, detected, schema, applied, outcome: "migrated" }
}
