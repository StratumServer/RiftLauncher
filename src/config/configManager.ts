import { app } from "electron"
import fse from "fs-extra"
import { join } from "node:path"
import { logMessage } from "@src/utils/logManager"
import { parseLegacyAccount, toPublicAccount } from "@domain/account/credentials"
import { adoptLegacySingleAccountSecrets, saveAccountSecrets } from "@src/ipc/accountStore"
import { isRecord } from "@src/ipc/validation"
import { clampConfigSchema, CURRENT_CONFIG_SCHEMA, migrateConfigDocument } from "@domain/config/migrations"
import { normalizeBackgroundId } from "@domain/backgrounds"
import { normalizeModDbVisibilityAnswer } from "@domain/moddbVisibility"
import { normalizeReceiveBetaUpdates } from "@domain/appUpdate/betaUpdates"
import { DEFAULT_COMPRESSION_LEVEL, DEFAULT_CONFIG_BASE } from "@domain/config/defaults"

const defaultConfig: ConfigType = {
  ...DEFAULT_CONFIG_BASE,
  schemaVersion: CURRENT_CONFIG_SCHEMA,
  defaultInstallationsFolder: join(app.getPath("appData"), "RiftLauncherInstallations"),
  defaultVersionsFolder: join(app.getPath("appData"), "RiftLauncherGameVersions"),
  backupsFolder: join(app.getPath("appData"), "RiftLauncherBackups")
}

const defaultInstallation: InstallationType = {
  id: "",
  name: "",
  icon: "",
  path: "",
  version: "",
  startParams: "",
  backupsLimit: 3,
  backupsAuto: false,
  compressionLevel: DEFAULT_COMPRESSION_LEVEL,
  backups: [],
  lastTimePlayed: -1,
  totalTimePlayed: 0,
  mesaGlThread: false,
  envVars: ""
}

let configPath: string
let configReady = false
let configCache: ConfigType | null = null
let configWriteQueue: Promise<void> = Promise.resolve()
let pendingConfig: ConfigType | null = null
let scheduledConfigWrite: Promise<void> | null = null

async function writeConfig(normalizedConfig: ConfigType): Promise<void> {
  const cleanedConfig = JSON.parse(
    JSON.stringify(normalizedConfig, (key, value) => {
      return key.startsWith("_") ? undefined : value
    })
  )
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`

  try {
    await fse.writeJSON(temporaryPath, cleanedConfig)
    await fse.move(temporaryPath, configPath, { overwrite: true })
  } finally {
    await fse.remove(temporaryPath).catch(() => undefined)
  }
}

function scheduleConfigWrite(): Promise<void> {
  // Compared against null rather than tested for truthiness: the question is whether a write is already scheduled, not whether a promise is truthy (it always is).
  if (scheduledConfigWrite !== null) return scheduledConfigWrite

  const write = configWriteQueue.then(async () => {
    // Config state can change several times during one renderer interaction. Coalesce those transitions into one atomic write.
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    while (pendingConfig) {
      const nextConfig = pendingConfig
      pendingConfig = null
      await writeConfig(nextConfig)
    }
  })

  scheduledConfigWrite = write.finally(() => {
    scheduledConfigWrite = null
  })
  configWriteQueue = scheduledConfigWrite.catch(() => undefined)
  return scheduledConfigWrite
}

export async function saveConfig(config: ConfigType): Promise<boolean> {
  if (!configPath) configPath = join(app.getPath("userData"), "config.json")
  const normalizedConfig = normalizeConfig(config)
  configCache = normalizedConfig
  pendingConfig = normalizedConfig
  const queuedWrite = scheduleConfigWrite()

  try {
    await queuedWrite
    configReady = true
    return true
  } catch (err) {
    logMessage("error", "[back] [config] [config/configManager.ts] [saveConfig] Error saving configuration.")
    logMessage("debug", `[back] [config] [config/configManager.ts] [saveConfig] ${err}`)
    return false
  }
}

export function flushConfigWrites(): Promise<void> | null {
  return scheduledConfigWrite
}

export async function getConfig(): Promise<ConfigType> {
  try {
    if (!(await ensureConfig())) return defaultConfig
    if (configCache) return normalizeConfig(configCache)
    const config = await fse.readJSON(configPath, "utf-8")
    const hadLegacyAccountSecrets = await migrateLegacyAccount(config)
    const reKeyedAccountStore = await migrateAccountStore(config)
    const migration = migrateConfigDocument(config)
    logConfigMigration(migration)
    if (migration.applied.length > 0) await backupConfigBeforeMigration()
    const ensuredConfig = normalizeConfig(migration.doc)
    configCache = ensuredConfig
    if (hadLegacyAccountSecrets || reKeyedAccountStore || migration.applied.length > 0) await saveConfig(ensuredConfig)
    return ensuredConfig
  } catch (err) {
    logMessage("error", `[back] [config] [config/configManager.ts] [getConfig] Error getting config at ${configPath}. Using default config.`)
    logMessage("debug", `[back] [config] [config/configManager.ts] [getConfig] Error getting config at ${configPath}: ${err}`)
    await saveConfig(defaultConfig)
    return defaultConfig
  }
}

export async function ensureConfig(): Promise<boolean> {
  if (configReady) return true
  configPath = join(app.getPath("userData"), "config.json")
  try {
    if (!(await fse.pathExists(configPath))) {
      logMessage("info", `[back] [config] [config/configManager.ts] [ensureConfig] Config not found. Creating default config.`)
      return await saveConfig(defaultConfig)
    }
    configReady = true
    logMessage("info", `[back] [config] [config/configManager.ts] [ensureConfig] Config found at ${configPath}.`)
    return true
  } catch (err) {
    logMessage("error", `[back] [config] [config/configManager.ts] [ensureConfig] Error ensuring config.`)
    logMessage("error", `[back] [config] [config/configManager.ts] [ensureConfig] Error ensuring config at ${configPath}: ${err}`)
    return false
  }
}

/** Says what the schema pipeline did with the stored document, and at what level it deserves saying. */
function logConfigMigration(migration: ReturnType<typeof migrateConfigDocument>): void {
  const prefix = "[back] [config] [config/configManager.ts] [getConfig]"
  const steps = migration.applied.map((step) => `${step.fromSchema}->${step.toSchema}`).join(", ")

  switch (migration.outcome) {
    case "migrated":
      return logMessage("info", `${prefix} Config migrated from the ${migration.detected.era} era to schema ${migration.schema} (${steps}).`)
    case "future-schema":
      return logMessage("warn", `${prefix} Config carries schema ${migration.schema}, newer than the ${CURRENT_CONFIG_SCHEMA} this build knows. Reading it as is, not downgrading it.`)
    case "chain-broken":
      return logMessage("warn", `${prefix} No migration continues the chain past schema ${migration.schema}. Reading the config as it stands.`)
    case "migration-failed":
      return logMessage("error", `${prefix} A config migration failed at schema ${migration.schema}. Reading the config as it stands.`)
    case "unreadable":
      return logMessage("warn", `${prefix} Config is not an object. Falling back to defaults.`)
    default:
      return
  }
}

/**
 * Moves the credentials of a pre-secure-storage account into the OS keychain.
 *
 * Kept out of the schema pipeline on purpose. Every step in
 * {@link migrateConfigDocument} is a pure document transform; this one writes
 * to secure storage and can fail on its own terms, which is a side effect the
 * domain layer is not allowed to have. It runs before the pipeline and stays
 * shaped exactly as it always was: the account fields it leaves behind are
 * stripped later by `toPublicAccount`, whatever schema the document is at.
 */
async function migrateLegacyAccount(config: unknown): Promise<boolean> {
  if (!isRecord(config) || !isRecord(config.account)) return false
  const account = config.account
  const hasLegacySecrets = ["sessionKey", "sessionSignature", "mptoken"].some((key) => key in account)
  if (!hasLegacySecrets) return false

  const legacyAccount = parseLegacyAccount(config.account)

  if (legacyAccount) {
    try {
      await saveAccountSecrets(legacyAccount.publicAccount.playerUid, legacyAccount.secrets)
    } catch {
      logMessage("warn", "[back] [config] [configManager.ts] Legacy account credentials were not migrated to secure storage.")
    }
  } else {
    logMessage("warn", "[back] [config] [configManager.ts] Legacy account credentials were invalid and were discarded.")
  }

  return true
}

/**
 * Re-keys a single-account secret store under the account it belongs to.
 *
 * The v1 store held one `AccountSecrets` with no account attached to it; the
 * v2 store (see `src/ipc/accountStore.ts`) holds entries keyed by
 * `playerUid`. The only place that missing key exists is
 * `config.account.playerUid`, which is why this runs here, reading the raw
 * pre-pipeline document exactly as {@link migrateLegacyAccount} does, and not
 * inside `accountStore.ts` itself: the store cannot name its own contents.
 * Kept out of the schema pipeline for the same reason `migrateLegacyAccount`
 * is: a side effect the pure domain layer is not allowed to have.
 *
 * A config with no readable account, or a v1 store that has already been
 * re-keyed (or never existed), makes this a safe no-op: `false` either way,
 * same as `migrateLegacyAccount` when there is nothing to do.
 */
async function migrateAccountStore(config: unknown): Promise<boolean> {
  if (!isRecord(config) || !isRecord(config.account)) return false
  const uid = config.account.playerUid
  if (typeof uid !== "string" || uid.length === 0) return false

  try {
    return await adoptLegacySingleAccountSecrets(uid)
  } catch {
    logMessage("warn", "[back] [config] [configManager.ts] The stored account session was not carried into the multi-account store.")
    return false
  }
}

function getConfigBackupPath(): string {
  return join(app.getPath("userData"), "config.pre-migration.bak.json")
}

/**
 * Copies `config.json` exactly as it sits on disk, before a schema migration
 * overwrites it with the reshaped document.
 *
 * One rolling backup, not one per migration: this is a local single-writer
 * desktop file, not a fleet of servers, so "the config as it was right before
 * the most recent migration" is the useful recovery point, not a full
 * history. `overwrite: false` with `errorOnExist: false` makes the first
 * migration's backup the one that survives; a later migration on an already-
 * backed-up config leaves that earlier, more original snapshot alone. Best
 * effort: a failed backup logs and does not stop the migration, since the
 * live config is still correct either way and refusing to proceed over a
 * backup that could not be written would trade a small safety net for a
 * launcher that will not start.
 */
async function backupConfigBeforeMigration(): Promise<void> {
  try {
    await fse.copy(configPath, getConfigBackupPath(), { overwrite: false, errorOnExist: false })
  } catch (err) {
    logMessage("warn", "[back] [config] [configManager.ts] Could not back up config.json before migrating it.")
    logMessage("debug", `[back] [config] [configManager.ts] ${err}`)
  }
}

function asString(value: unknown, fallback: string, maxLength = 4_096): string {
  return typeof value === "string" && value.length <= maxLength && !value.includes("\0") ? value : fallback
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function normalizeBackup(value: unknown): BackupType | null {
  if (!isRecord(value)) return null
  const id = asString(value.id, "", 128)
  const path = asString(value.path, "")
  if (!id || !path) return null
  return {
    id,
    date: asNumber(value.date, 0, 0, Number.MAX_SAFE_INTEGER),
    path
  }
}

function normalizeInstallation(value: unknown): InstallationType | null {
  if (!isRecord(value)) return null
  const installation: InstallationType = {
    id: asString(value.id, "", 128),
    name: asString(value.name, "", 256),
    icon: asString(value.icon, "", 256),
    path: asString(value.path, ""),
    version: asString(value.version, "", 128),
    startParams: asString(value.startParams, "", 8_192),
    backupsLimit: asNumber(value.backupsLimit, defaultInstallation.backupsLimit, 0, 100),
    backupsAuto: asBoolean(value.backupsAuto, defaultInstallation.backupsAuto),
    compressionLevel: Math.trunc(asNumber(value.compressionLevel, defaultInstallation.compressionLevel, 0, 9)),
    backups: Array.isArray(value.backups)
      ? value.backups
          .map(normalizeBackup)
          .filter((backup): backup is BackupType => backup !== null)
          .slice(0, 100)
      : [],
    lastTimePlayed: asNumber(value.lastTimePlayed, defaultInstallation.lastTimePlayed, -1, Number.MAX_SAFE_INTEGER),
    totalTimePlayed: asNumber(value.totalTimePlayed, defaultInstallation.totalTimePlayed, 0, Number.MAX_SAFE_INTEGER),
    mesaGlThread: asBoolean(value.mesaGlThread, defaultInstallation.mesaGlThread),
    envVars: asString(value.envVars, "", 8_192)
  }

  return installation.id && installation.path ? installation : null
}

function normalizeGameVersion(value: unknown): GameVersionType | null {
  if (!isRecord(value)) return null
  const gameVersion: GameVersionType = {
    version: asString(value.version, "", 128),
    path: asString(value.path, "")
  }
  // Only set when true so a plain version, or an unset one, doesn't grow a `linked: false`
  // it never had. This flag is what keeps a player's own install off the delete path, so
  // dropping it silently on the next load would turn "remove from list" back into deletion.
  if (asBoolean(value.linked, false)) gameVersion.linked = true
  return gameVersion.version && gameVersion.path ? gameVersion : null
}

function normalizeIcon(value: unknown): IconType | null {
  if (!isRecord(value)) return null
  const icon: IconType = {
    id: asString(value.id, "", 128),
    name: asString(value.name, "", 256),
    icon: asString(value.icon, "", 4_096),
    custom: value.custom === true
  }
  return icon.id && icon.name && icon.icon.toLowerCase().endsWith(".png") ? icon : null
}

/** Ceiling on saved accounts, the same shape as the 1,000-entry caps above: generous for the real use case, not a promise to scale past it. */
const MAX_STORED_ACCOUNTS = 50

/** Reads the accounts list, dropping anything unreadable and deduplicating by `playerUid`. */
function normalizeAccounts(value: unknown): AccountPublicType[] {
  const seen = new Set<string>()
  return (Array.isArray(value) ? value : [])
    .map(toPublicAccount)
    .filter((account): account is AccountPublicType => account !== null)
    .filter((account) => {
      if (seen.has(account.playerUid)) return false
      seen.add(account.playerUid)
      return true
    })
    .slice(0, MAX_STORED_ACCOUNTS)
}

export function normalizeConfig(config: unknown): ConfigType {
  const rawConfig = (isRecord(config) ? config : {}) as Partial<ConfigType>
  const rawWindow = (isRecord(rawConfig.window) ? rawConfig.window : {}) as Partial<WindowType>
  const installations = (Array.isArray(rawConfig.installations) ? rawConfig.installations : [])
    .map(normalizeInstallation)
    .filter((installation): installation is InstallationType => installation !== null)
    .slice(0, 1_000)

  const gameVersions = (Array.isArray(rawConfig.gameVersions) ? rawConfig.gameVersions : [])
    .map(normalizeGameVersion)
    .filter((gameVersion): gameVersion is GameVersionType => gameVersion !== null)
    .slice(0, 1_000)

  const customIcons = (Array.isArray(rawConfig.customIcons) ? rawConfig.customIcons : [])
    .map(normalizeIcon)
    .filter((icon): icon is IconType => icon !== null)
    .slice(0, 1_000)

  const accounts = normalizeAccounts(rawConfig.accounts)

  const fixedConfig: ConfigType = {
    schemaVersion: clampConfigSchema(rawConfig.schemaVersion),
    lastUsedInstallation: rawConfig.lastUsedInstallation === null ? null : asString(rawConfig.lastUsedInstallation, defaultConfig.lastUsedInstallation ?? "", 128) || null,
    defaultInstallationsFolder: asString(rawConfig.defaultInstallationsFolder, defaultConfig.defaultInstallationsFolder),
    defaultVersionsFolder: asString(rawConfig.defaultVersionsFolder, defaultConfig.defaultVersionsFolder),
    backupsFolder: asString(rawConfig.backupsFolder, defaultConfig.backupsFolder),
    window: {
      width: Math.trunc(asNumber(rawWindow.width, defaultConfig.window.width, 1_024, 8_192)),
      height: Math.trunc(asNumber(rawWindow.height, defaultConfig.window.height, 600, 8_192)),
      x: Math.trunc(asNumber(rawWindow.x, defaultConfig.window.x, -100_000, 100_000)),
      y: Math.trunc(asNumber(rawWindow.y, defaultConfig.window.y, -100_000, 100_000)),
      maximized: asBoolean(rawWindow.maximized, defaultConfig.window.maximized)
    },
    accounts,
    // An id naming nobody falls back to the first saved account rather than to null: a
    // household that lost its choice (a dangling id, or a config hand-edited down to one
    // fewer account) should land on someone, not on "no account selected". Every reader
    // downstream (EXECUTE_GAME, the renderer contexts) can then do a plain lookup with no
    // fallback branch of its own, because this is the one place the invariant is enforced:
    // activeAccountId either names an entry in accounts, or is null when accounts is empty.
    activeAccountId: accounts.some((account) => account.playerUid === rawConfig.activeAccountId) ? (rawConfig.activeAccountId as string) : (accounts[0]?.playerUid ?? null),
    installations,
    gameVersions,
    favMods: Array.isArray(rawConfig.favMods) ? rawConfig.favMods.filter((modId): modId is number => typeof modId === "number" && Number.isSafeInteger(modId)).slice(0, 10_000) : defaultConfig.favMods,
    suspendedModUpdates: Array.isArray(rawConfig.suspendedModUpdates)
      ? rawConfig.suspendedModUpdates.filter((modid): modid is string => typeof modid === "string" && modid.length > 0).slice(0, 10_000)
      : defaultConfig.suspendedModUpdates,
    // A stored id survives whether or not the catalog still lists it: the manifest is not
    // readable from here, and a scene retired from the branch for a week should not silently
    // reset a player's choice. Anything that is not a usable id falls back to the bundled scene,
    // which is also what the renderer paints when the cached file for an id has gone missing.
    background: normalizeBackgroundId(rawConfig.background),
    // Anything unreadable becomes "not asked yet", which costs one question and never invents a
    // consent. The prompt is the only thing that ever writes a real answer here.
    moddbVisibilityAnswer: normalizeModDbVisibilityAnswer(rawConfig.moddbVisibilityAnswer),
    // Null for anything that is not an explicit yes or no, which is what every config written
    // before the toggle existed says, and leaves the running version deciding as it always did.
    receiveBetaUpdates: normalizeReceiveBetaUpdates(rawConfig.receiveBetaUpdates),
    customIcons
  }

  return fixedConfig
}
