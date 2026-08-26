import { DEFAULT_CONFIG_BASE } from "@domain/config/defaults"
import { type ModDbVisibilityAnswer } from "@domain/moddbVisibility"

export enum CONFIG_ACTIONS {
  SET_CONFIG = "SET_CONFIG",

  SET_LAST_USED_INSTALLATION = "SET_LAST_USED_INSTALLATION",
  SET_DEFAULT_INSTALLATIONS_FOLDER = "SET_DEFAULT_INSTALLATIONS_FOLDER",
  SET_DEFAULT_VERSIONS_FOLDER = "SET_DEFAULT_VERSIONS_FOLDER",
  SET_DEFAULT_BACKUPS_FOLDER = "SET_DEFAULT_BACKUPS_FOLDER",
  ADD_ACCOUNT = "ADD_ACCOUNT",
  REMOVE_ACCOUNT = "REMOVE_ACCOUNT",
  SET_ACTIVE_ACCOUNT = "SET_ACTIVE_ACCOUNT",
  SET_BACKGROUND = "SET_BACKGROUND",
  SET_MODDB_VISIBILITY_ANSWER = "SET_MODDB_VISIBILITY_ANSWER",
  SET_RECEIVE_BETA_UPDATES = "SET_RECEIVE_BETA_UPDATES",

  ADD_INSTALLATION = "ADD_INSTALLATION",
  DELETE_INSTALLATION = "DELETE_INSTALLATION",
  EDIT_INSTALLATION = "EDIT_INSTALLATION",
  MOVE_INSTALLATION = "MOVE_INSTALLATION",
  ADD_INSTALLATION_BACKUP = "ADD_INSTALLATION_BACKUP",
  DELETE_INSTALLATION_BACKUP = "DELETE_INSTALLATION_BACKUP",
  EDIT_INSTALLATION_BACKUP = "EDIT_INSTALLATION_BACKUP",

  ADD_GAME_VERSION = "ADD_GAME_VERSION",
  DELETE_GAME_VERSION = "DELETE_GAME_VERSION",
  EDIT_GAME_VERSION = "EDIT_GAME_VERSION",

  ADD_FAV_MOD = "ADD_FAV_MOD",
  REMOVE_FAV_MOD = "REMOVE_FAV_MOD",

  ADD_SUSPENDED_MOD_UPDATE = "ADD_SUSPENDED_MOD_UPDATE",
  REMOVE_SUSPENDED_MOD_UPDATE = "REMOVE_SUSPENDED_MOD_UPDATE",

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

/**
 * Saves a fresh login, or refreshes an already-saved account's session.
 *
 * Also chooses it: an account just proven by a successful login is the one
 * the player wants to play as. The same `playerUid` twice replaces the entry
 * in place rather than duplicating it, which is what a session refresh is.
 */
export interface AddAccount {
  type: CONFIG_ACTIONS.ADD_ACCOUNT
  payload: AccountPublicType
}

/**
 * Drops one saved account. If it was the active one, the first remaining
 * account is promoted; an empty list leaves `activeAccountId` null.
 */
export interface RemoveAccount {
  type: CONFIG_ACTIONS.REMOVE_ACCOUNT
  payload: { playerUid: string }
}

/** Chooses which saved account the next game launch writes into clientsettings.json. An id naming nobody is a no-op. */
export interface SetActiveAccount {
  type: CONFIG_ACTIONS.SET_ACTIVE_ACCOUNT
  payload: string | null
}

/**
 * Picks the background: the bundled default, a catalog id, or the reserved custom id.
 *
 * Also bumps `_backgroundRevision`, including when the id has not changed. Re-picking a new
 * picture writes over the one file the custom slot owns, so the id alone cannot tell the renderer
 * that anything happened, and the URL it paints has to move for the new bytes to be read.
 */
export interface SetBackground {
  type: CONFIG_ACTIONS.SET_BACKGROUND
  payload: string
}

/**
 * Records the answer to the one-time ModDB listing question, which is what stops it being asked
 * again. Dispatched from the three buttons on the prompt and from nowhere else: closing it without
 * answering must leave the config alone so the question survives to the next launch.
 */
export interface SetModDbVisibilityAnswer {
  type: CONFIG_ACTIONS.SET_MODDB_VISIBILITY_ANSWER
  payload: ModDbVisibilityAnswer
}

/**
 * Answers, once and for good, whether update checks may offer beta builds.
 *
 * Only ever an explicit true or false: the stored `null` this replaces means nobody has answered,
 * and the toggle is what turns that into an answer. See src/domain/appUpdate/betaUpdates.ts.
 */
export interface SetReceiveBetaUpdates {
  type: CONFIG_ACTIONS.SET_RECEIVE_BETA_UPDATES
  payload: boolean
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

/**
 * Swaps one installation with its neighbour. The array order is the display
 * order (nothing sorts `installations` on the way to the screen), so this is
 * the whole of "reorder the list" as far as state goes.
 */
export interface MoveInstallation {
  type: CONFIG_ACTIONS.MOVE_INSTALLATION
  payload: {
    id: string
    direction: "up" | "down"
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

/** Holds one Mod back: Update All skips it until the suspension is lifted. Its own row can still update it. */
export interface AddSuspendedModUpdate {
  type: CONFIG_ACTIONS.ADD_SUSPENDED_MOD_UPDATE
  payload: {
    modid: string
  }
}

export interface RemoveSuspendedModUpdate {
  type: CONFIG_ACTIONS.REMOVE_SUSPENDED_MOD_UPDATE
  payload: {
    modid: string
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
  | AddAccount
  | RemoveAccount
  | SetActiveAccount
  | SetBackground
  | SetModDbVisibilityAnswer
  | SetReceiveBetaUpdates
  | AddInstallation
  | DeleteInstallation
  | EditInstallation
  | MoveInstallation
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
  | AddSuspendedModUpdate
  | RemoveSuspendedModUpdate
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
    case CONFIG_ACTIONS.ADD_ACCOUNT: {
      const others = config.accounts.filter((account) => account.playerUid !== action.payload.playerUid)
      return { ...config, accounts: [...others, action.payload], activeAccountId: action.payload.playerUid }
    }
    case CONFIG_ACTIONS.REMOVE_ACCOUNT: {
      const accounts = config.accounts.filter((account) => account.playerUid !== action.payload.playerUid)
      const activeAccountId = config.activeAccountId === action.payload.playerUid ? (accounts[0]?.playerUid ?? null) : config.activeAccountId
      return { ...config, accounts, activeAccountId }
    }
    case CONFIG_ACTIONS.SET_ACTIVE_ACCOUNT:
      // An id naming nobody is a no-op returning the same object, so nothing re-renders for it,
      // the same shape MOVE_INSTALLATION's guard above already uses.
      if (action.payload !== null && !config.accounts.some((account) => account.playerUid === action.payload)) return config
      return { ...config, activeAccountId: action.payload }
    case CONFIG_ACTIONS.SET_BACKGROUND:
      return { ...config, background: action.payload, _backgroundRevision: (config._backgroundRevision ?? 0) + 1 }
    case CONFIG_ACTIONS.SET_MODDB_VISIBILITY_ANSWER:
      return { ...config, moddbVisibilityAnswer: action.payload }
    case CONFIG_ACTIONS.SET_RECEIVE_BETA_UPDATES:
      return { ...config, receiveBetaUpdates: action.payload }
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
    case CONFIG_ACTIONS.MOVE_INSTALLATION: {
      const from = config.installations.findIndex((installation) => installation.id === action.payload.id)
      const to = from + (action.payload.direction === "up" ? -1 : 1)
      // An id naming nothing, or a row already at the end it is being pushed
      // towards: same state object back, so nothing re-renders for a no-op.
      if (from === -1 || to < 0 || to >= config.installations.length) return config

      const installations = [...config.installations]
      const moved = installations[from]!
      installations[from] = installations[to]!
      installations[to] = moved
      return { ...config, installations }
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
    case CONFIG_ACTIONS.ADD_SUSPENDED_MOD_UPDATE:
      return {
        ...config,
        suspendedModUpdates: [...config.suspendedModUpdates, action.payload.modid]
      }
    case CONFIG_ACTIONS.REMOVE_SUSPENDED_MOD_UPDATE:
      return {
        ...config,
        suspendedModUpdates: config.suspendedModUpdates.filter((modid) => modid !== action.payload.modid)
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
  ...DEFAULT_CONFIG_BASE,
  // Sentinel until the main process answers with the stored config: no real schema is 0.
  // The migration runner owns this marker; the renderer receives it through SET_CONFIG.
  schemaVersion: 0,
  // Empty until the main process sends the real ones: only it can resolve appData.
  defaultInstallationsFolder: "",
  defaultVersionsFolder: "",
  backupsFolder: ""
}
