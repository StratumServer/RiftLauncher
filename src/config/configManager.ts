import { app } from "electron"
import fse from "fs-extra"
import { join } from "path"
import { logMessage } from "@src/utils/logManager"
import { parseLegacyAccount, toPublicAccount } from "@src/ipc/accountTypes"
import { saveAccountSecrets } from "@src/ipc/accountStore"
import { isRecord } from "@src/ipc/validation"
import { clampConfigSchema, CURRENT_CONFIG_SCHEMA, migrateConfigDocument } from "@domain/config/migrations"

const defaultConfig: ConfigType = {
  schemaVersion: CURRENT_CONFIG_SCHEMA,
  lastUsedInstallation: null,
  defaultInstallationsFolder: join(app.getPath("appData"), "VSLInstallations"),
  defaultVersionsFolder: join(app.getPath("appData"), "VSLGameVersions"),
  backupsFolder: join(app.getPath("appData"), "VSLBackups"),
  window: {
    width: 1280,
    height: 720,
    x: 0,
    y: 0,
    maximized: false
  },
  account: null,
  installations: [],
  gameVersions: [],
  favMods: [],
  customIcons: []
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
  compressionLevel: 4,
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
  if (scheduledConfigWrite) return scheduledConfigWrite

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
    const migration = migrateConfigDocument(config)
    logConfigMigration(migration)
    const ensuredConfig = normalizeConfig(migration.doc)
    configCache = ensuredConfig
    if (hadLegacyAccountSecrets || migration.applied.length > 0) await saveConfig(ensuredConfig)
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
      await saveAccountSecrets(legacyAccount.secrets)
    } catch {
      logMessage("warn", "[back] [config] [configManager.ts] Legacy account credentials were not migrated to secure storage.")
    }
  } else {
    logMessage("warn", "[back] [config] [configManager.ts] Legacy account credentials were invalid and were discarded.")
  }

  return true
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
    account: toPublicAccount(rawConfig.account),
    installations,
    gameVersions,
    favMods: Array.isArray(rawConfig.favMods) ? rawConfig.favMods.filter((modId): modId is number => typeof modId === "number" && Number.isSafeInteger(modId)).slice(0, 10_000) : defaultConfig.favMods,
    customIcons
  }

  return fixedConfig
}
