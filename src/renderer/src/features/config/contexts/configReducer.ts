export enum CONFIG_ACTIONS {
  SET_CONFIG = "SET_CONFIG",

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
  DELETE_CUSTOM_ICON = "DELETE_CUSTOM_ICON",

  ADD_NOTIFIED_MOD_UPDATE = "ADD_NOTIFIED_MOD_UPDATE"
}

export interface SetConfig {
  type: CONFIG_ACTIONS.SET_CONFIG
  payload: ConfigType
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

/**
 * Records that the player has been told about mod updates for one
 * installation, so GlobalModUpdateChecker's de-dupe survives a revisit
 * without renotifying. Session-only bookkeeping: normalizeConfig
 * (src/config/configManager.ts) does not carry `_notifiedModUpdatesInstallations`
 * into the fields it writes back out, so this state never reaches disk and
 * resets every launch, same as before this action existed.
 */
export interface AddNotifiedModUpdate {
  type: CONFIG_ACTIONS.ADD_NOTIFIED_MOD_UPDATE
  payload: {
    installationId: string
  }
}

export type ConfigAction =
  | SetConfig
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
  | AddNotifiedModUpdate

/**
 * The single config reducer. Every case rebuilds the root object but leaves the
 * slices it does not touch referentially untouched, which is what lets the
 * per-domain contexts in ConfigContext.tsx hand out stable values: editing a
 * game version cannot make `installations` look new to React.
 */
export const configReducer = (config: ConfigType, action: ConfigAction): ConfigType => {
  switch (action.type) {
    case CONFIG_ACTIONS.SET_CONFIG:
      return action.payload
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
    case CONFIG_ACTIONS.ADD_NOTIFIED_MOD_UPDATE: {
      const notified = config._notifiedModUpdatesInstallations ?? []
      if (notified.includes(action.payload.installationId)) return config
      return { ...config, _notifiedModUpdatesInstallations: [...notified, action.payload.installationId] }
    }
    default:
      return config
  }
}

export const initialState: ConfigType = {
  // Sentinel until the main process answers with the stored config: no real schema is 0.
  // The migration runner owns this marker; the renderer receives it through SET_CONFIG.
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
