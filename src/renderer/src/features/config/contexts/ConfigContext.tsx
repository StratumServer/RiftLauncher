import { createContext, useContext, useEffect, useReducer, useState } from "react"

import { useGetInstalledMods } from "@renderer/features/mods/hooks/useGetInstalledMods"

export enum CONFIG_ACTIONS {
  SET_CONFIG = "SET_CONFIG",

  SET_SCHEMA_VERSION = "SET_SCHEMA_VERSION",
  SET_LAST_USED_INSTALLATION = "SET_LAST_USED_INSTALLATION",
  SET_DEFAULT_INSTALLATIONS_FOLDER = "SET_DEFAULT_INSTALLATIONS_FOLDER",
  SET_DEFAULT_VERSIONS_FOLDER = "SET_DEFAULT_VERSIONS_FOLDER",
  SET_DEFAULT_BACKUPS_FOLDER = "SET_DEFAULT_BACKUPS_FOLDER",
  SET_ACCOUNT = "SET_ACCOUNT",

  ADD_INSTALLATION = "ADD_INSTALLATION",
  DELETE_INSTALLATION = "DELETE_INSTALLATION",
  EDIT_INSTALLATION = "EDIT_INSTALLATION",
  ADD_INSTALLATION_BACKUP = "ADD_INSTALLATION_BACKUP",
  DELETE_INSTALLATION_BACKUP = "DELETE_INSTALLATION_BACKUP",
  EDIT_INSTALLATION_BACKUP = "EDIT_INSTALLATION_BACKUP",

  ADD_GAME_VERSION = "ADD_GAME_VERSION",
  DELETE_GAME_VERSION = "DELETE_GAME_VERSION",
  EDIT_GAME_VERSION = "EDIT_GAME_VERSION",

  ADD_FAV_MOD = "ADD_FAV_MOD",
  REMOVE_FAV_MOD = "REMOVE_FAV_MOD",

  ADD_CUSTOM_ICON = "ADD_CUSTOM_ICON",
  DELETE_CUSTOM_ICON = "DELETE_CUSTOM_ICON"
}

export interface SetConfig {
  type: CONFIG_ACTIONS.SET_CONFIG
  payload: ConfigType
}

export interface SetSchemaVersion {
  type: CONFIG_ACTIONS.SET_SCHEMA_VERSION
  payload: number
}

export interface SetLastUsedInstallation {
  type: CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION
  payload: string | null
}

export interface SetDefaultInstllationsFolder {
  type: CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER
  payload: string
}

export interface SetDefaultVersionsFolder {
  type: CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER
  payload: string
}

export interface SetDefaultBackupsFolder {
  type: CONFIG_ACTIONS.SET_DEFAULT_BACKUPS_FOLDER
  payload: string
}

export interface SetAccount {
  type: CONFIG_ACTIONS.SET_ACCOUNT
  payload: AccountType | null
}

export interface AddInstallation {
  type: CONFIG_ACTIONS.ADD_INSTALLATION
  payload: InstallationType
}

export interface DeleteInstallation {
  type: CONFIG_ACTIONS.DELETE_INSTALLATION
  payload: { id: string }
}

export interface EditInstallation {
  type: CONFIG_ACTIONS.EDIT_INSTALLATION
  payload: {
    id: string
    updates: Partial<Omit<InstallationType, "id">>
  }
}

export interface AddInstallationBackup {
  type: CONFIG_ACTIONS.ADD_INSTALLATION_BACKUP
  payload: {
    id: string
    backup: BackupType
  }
}

export interface DeleteInstallationBackup {
  type: CONFIG_ACTIONS.DELETE_INSTALLATION_BACKUP
  payload: {
    id: string
    backupId: string
  }
}

export interface AddCustomIcon {
  type: CONFIG_ACTIONS.ADD_CUSTOM_ICON
  payload: IconType
}

export interface DeleteCustomIcon {
  type: CONFIG_ACTIONS.DELETE_CUSTOM_ICON
  payload: {
    id: string
  }
}

export interface EditInslallationBackup {
  type: CONFIG_ACTIONS.EDIT_INSTALLATION_BACKUP
  payload: {
    id: string
    backupId: string
    updates: Partial<Omit<BackupType, "id">>
  }
}

export interface AddGameVersion {
  type: CONFIG_ACTIONS.ADD_GAME_VERSION
  payload: GameVersionType
}

export interface DeleteGameVersion {
  type: CONFIG_ACTIONS.DELETE_GAME_VERSION
  payload: { version: string }
}

export interface EditGameVersion {
  type: CONFIG_ACTIONS.EDIT_GAME_VERSION
  payload: {
    version: string
    updates: Partial<Omit<GameVersionType, "version">>
  }
}

export interface AddFavMod {
  type: CONFIG_ACTIONS.ADD_FAV_MOD
  payload: {
    modid: number
  }
}

export interface RemoveFavMod {
  type: CONFIG_ACTIONS.REMOVE_FAV_MOD
  payload: {
    modid: number
  }
}

export type ConfigAction =
  | SetConfig
  | SetSchemaVersion
  | SetLastUsedInstallation
  | SetDefaultInstllationsFolder
  | SetDefaultVersionsFolder
  | SetDefaultBackupsFolder
  | SetAccount
  | AddInstallation
  | DeleteInstallation
  | EditInstallation
  | AddInstallationBackup
  | DeleteInstallationBackup
  | EditInslallationBackup
  | AddCustomIcon
  | DeleteCustomIcon
  | AddGameVersion
  | DeleteGameVersion
  | EditGameVersion
  | AddFavMod
  | RemoveFavMod

const configReducer = (config: ConfigType, action: ConfigAction): ConfigType => {
  switch (action.type) {
    case CONFIG_ACTIONS.SET_CONFIG:
      return action.payload
    case CONFIG_ACTIONS.SET_SCHEMA_VERSION:
      return { ...config, schemaVersion: action.payload }
    case CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION:
      return { ...config, lastUsedInstallation: action.payload }
    case CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER:
      return { ...config, defaultInstallationsFolder: action.payload }
    case CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER:
      return { ...config, defaultVersionsFolder: action.payload }
    case CONFIG_ACTIONS.SET_DEFAULT_BACKUPS_FOLDER:
      return { ...config, backupsFolder: action.payload }
    case CONFIG_ACTIONS.SET_ACCOUNT:
      return { ...config, account: action.payload }
    case CONFIG_ACTIONS.ADD_INSTALLATION:
      return { ...config, installations: [action.payload, ...config.installations] }
    case CONFIG_ACTIONS.DELETE_INSTALLATION:
      return {
        ...config,
        installations: config.installations.filter((installation) => installation.id !== action.payload.id)
      }
    case CONFIG_ACTIONS.EDIT_INSTALLATION:
      return {
        ...config,
        installations: config.installations.map((installation) => (installation.id === action.payload.id ? { ...installation, ...action.payload.updates } : installation))
      }
    case CONFIG_ACTIONS.ADD_INSTALLATION_BACKUP:
      return {
        ...config,
        installations: config.installations.map((installation) =>
          installation.id === action.payload.id ? { ...installation, backups: [action.payload.backup, ...installation.backups] } : installation
        )
      }
    case CONFIG_ACTIONS.DELETE_INSTALLATION_BACKUP:
      return {
        ...config,
        installations: config.installations.map((installation) =>
          installation.id === action.payload.id
            ? {
                ...installation,
                backups: installation.backups.filter((backup) => backup.id !== action.payload.backupId)
              }
            : installation
        )
      }
    case CONFIG_ACTIONS.EDIT_INSTALLATION_BACKUP:
      return {
        ...config,
        installations: config.installations.map((installation) =>
          installation.id === action.payload.id
            ? {
                ...installation,
                backups: installation.backups.map((backup) => (backup.id === action.payload.backupId ? { ...backup, ...action.payload.updates } : backup))
              }
            : installation
        )
      }
    case CONFIG_ACTIONS.ADD_CUSTOM_ICON:
      return { ...config, customIcons: [...config.customIcons, action.payload] }
    case CONFIG_ACTIONS.DELETE_CUSTOM_ICON:
      return {
        ...config,
        customIcons: config.customIcons.filter((customIcon) => customIcon.id !== action.payload.id)
      }
    case CONFIG_ACTIONS.ADD_GAME_VERSION:
      return { ...config, gameVersions: [action.payload, ...config.gameVersions] }
    case CONFIG_ACTIONS.DELETE_GAME_VERSION:
      return {
        ...config,
        gameVersions: config.gameVersions.filter((gameVersion) => gameVersion.version !== action.payload.version)
      }
    case CONFIG_ACTIONS.EDIT_GAME_VERSION:
      return {
        ...config,
        gameVersions: config.gameVersions.map((gameVersion) => (gameVersion.version === action.payload.version ? { ...gameVersion, ...action.payload.updates } : gameVersion))
      }
    case CONFIG_ACTIONS.ADD_FAV_MOD:
      return {
        ...config,
        favMods: [...config.favMods, action.payload.modid]
      }
    case CONFIG_ACTIONS.REMOVE_FAV_MOD:
      return {
        ...config,
        favMods: config.favMods.filter((fm) => fm !== action.payload.modid)
      }
    default:
      return config
  }
}

export const initialState: ConfigType = {
  // Sentinel until the main process answers with the stored config: no real schema is 0.
  schemaVersion: 0,
  lastUsedInstallation: null,
  defaultInstallationsFolder: "",
  defaultVersionsFolder: "",
  backupsFolder: "",
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

interface ConfigContextType {
  config: ConfigType
  configDispatch: React.Dispatch<ConfigAction>
}

const ConfigContext = createContext<ConfigContextType | null>(null)

const ConfigProvider = ({ children }: { children: React.ReactNode }): JSX.Element => {
  const [config, configDispatch] = useReducer(configReducer, initialState)
  const [isConfigLoaded, setIsConfigLoaded] = useState(false)

  const getInstalledMods = useGetInstalledMods()

  useEffect(() => {
    ;(async (): Promise<void> => {
      window.api.utils.logMessage("info", `[front] [config] [features/config/contexts/ConfigCntext.tsx] [ConfigProvider] Setting context config from config file.`)
      const config = await window.api.configManager.getConfig()
      configDispatch({ type: CONFIG_ACTIONS.SET_CONFIG, payload: config })
    })()
  }, [])

  useEffect(() => {
    if (!isConfigLoaded && config.schemaVersion !== 0) setIsConfigLoaded(true)
    if (!isConfigLoaded) return
    window.api.configManager.saveConfig(config)
  }, [config])

  useEffect(() => {
    if (!isConfigLoaded) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        for (const installation of config.installations) {
          if (cancelled) return
          const mods = await getInstalledMods({ path: installation.path })
          if (cancelled) return
          const totalMods = mods.errors.length + mods.mods.length
          configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { _modsCount: totalMods } } })
        }
      })()
    }, 2_500)

    return (): void => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [isConfigLoaded])

  useEffect(() => {
    const firstInstallation = config.installations[0]
    if ((!config.lastUsedInstallation || !config.installations.some((i) => i.id === config.lastUsedInstallation)) && firstInstallation)
      configDispatch({ type: CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION, payload: firstInstallation.id })
  }, [config.installations])

  return <ConfigContext.Provider value={{ config, configDispatch }}>{children}</ConfigContext.Provider>
}

const useConfigContext = (): ConfigContextType => {
  const context = useContext(ConfigContext)
  if (context === null) {
    throw new Error("useConfigContext must be used within a ConfigProvider")
  }
  return context
}

export { ConfigProvider, useConfigContext }
