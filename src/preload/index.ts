import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function subscribeWithoutPayload(channel: string, callback: () => void): Unsubscribe {
  const listener = (): void => callback()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Custom APIs for renderer
const api: BridgeAPI = {
  utils: {
    getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.UTILS.GET_APP_VERSION),
    getOs: (): Promise<NodeJS.Platform> => ipcRenderer.invoke(IPC_CHANNELS.UTILS.GET_OS),
    logMessage: (mode: ErrorTypes, message: string): void => ipcRenderer.send(IPC_CHANNELS.UTILS.LOG_MESSAGE, mode, message),
    setPreventAppClose: (action: "add" | "remove", id: string, desc: string): void => ipcRenderer.send(IPC_CHANNELS.UTILS.SET_PREVENT_APP_CLOSE, action, id, desc),
    openOnBrowser: (url: string): void => ipcRenderer.send(IPC_CHANNELS.UTILS.OPEN_ON_BROWSER, url),
    selectFolderDialog: (options?: { type?: "file" | "folder"; mode?: "single" | "multi"; extensions?: string[] }): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.UTILS.SELECT_FOLDER_DIALOG, options),
    onPreventedAppClose: (callback: () => void): Unsubscribe => subscribeWithoutPayload(IPC_CHANNELS.UTILS.PREVENTED_APP_CLOSE, callback)
  },
  appUpdater: {
    onUpdateAvailable: (callback: UpdateAvailableCallback): Unsubscribe => subscribe(IPC_CHANNELS.APP_UPDATER.UPDATE_AVAILABLE, callback),
    onUpdateDownloadProgress: (callback: UpdateProgressCallback): Unsubscribe => subscribe(IPC_CHANNELS.APP_UPDATER.UPDATE_DOWNLOAD_PROGRESS, callback),
    onUpdateError: (callback: () => void): Unsubscribe => subscribeWithoutPayload(IPC_CHANNELS.APP_UPDATER.UPDATE_ERROR, callback),
    onUpdateDownloaded: (callback: () => void): Unsubscribe => subscribeWithoutPayload(IPC_CHANNELS.APP_UPDATER.UPDATE_DOWNLOADED, callback),
    downloadUpdate: (): void => ipcRenderer.send(IPC_CHANNELS.APP_UPDATER.DOWNLOAD_UPDATE),
    updateAndRestart: () => ipcRenderer.send(IPC_CHANNELS.APP_UPDATER.UPDATE_AND_RESTART)
  },
  configManager: {
    getConfig: (): Promise<ConfigType> => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_MANAGER.GET_CONFIG),
    saveConfig: (configJson: ConfigType): Promise<SaveConfigResult> => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_MANAGER.SAVE_CONFIG, configJson)
  },
  modsManager: {
    getInstalledMods: (path: string): Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }> => ipcRenderer.invoke(IPC_CHANNELS.MODS_MANAGER.GET_INSTALLED_MODS, path),
    setModEnabled: (path: string, enabled: boolean): Promise<SetModEnabledResult> => ipcRenderer.invoke(IPC_CHANNELS.MODS_MANAGER.SET_MOD_ENABLED, path, enabled),
    exportModpack: (manifest: ModpackManifestType): Promise<{ success: boolean; path?: string }> => ipcRenderer.invoke(IPC_CHANNELS.MODS_MANAGER.EXPORT_MODPACK, manifest),
    importModpack: (): Promise<{ success: boolean; manifest?: ModpackManifestType; error?: string }> => ipcRenderer.invoke(IPC_CHANNELS.MODS_MANAGER.IMPORT_MODPACK),
    clearModIconMemoryCache: (): void => ipcRenderer.send(IPC_CHANNELS.MODS_MANAGER.CLEAR_MOD_ICON_MEMORY_CACHE)
  },
  pathsManager: {
    getCurrentUserDataPath: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.GET_CURRENT_USER_DATA_PATH),
    deletePath: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.DELETE_PATH, path),
    movePath: (fromPath: string, toPath: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.MOVE_PATH, fromPath, toPath),
    formatPath: (parts: string[]): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.FORMAT_PATH, parts),
    removeFileFromPath: (path: string): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.REMOVE_FILE_FROM_PATH, path),
    checkPathEmpty: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EMPTY, path),
    checkPathExists: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.CHECK_PATH_EXISTS, path),
    ensurePathExists: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.ENSURE_PATH_EXISTS, path),
    openPathOnFileExplorer: (path: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.OPEN_PATH_ON_FILE_EXPLORER, path),
    downloadOnPath: (id: string, url: string, outputPath: string, fileName: string): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_ON_PATH, id, url, outputPath, fileName),
    extractOnPath: (id: string, filePath: string, outputPath: string, deleteZip: boolean, unwrapSingleRootFolder?: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_ON_PATH, id, filePath, outputPath, deleteZip, unwrapSingleRootFolder ?? false),
    runInstaller: (id: string, filePath: string, outputPath: string, deleteInstaller: boolean): Promise<InstallerRunResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.RUN_INSTALLER, id, filePath, outputPath, deleteInstaller),
    compressOnPath: (id: string, inputPath: string, outputPath: string, outputFileName: string, compressionLevel?: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.COMPRESS_ON_PATH, id, inputPath, outputPath, outputFileName, compressionLevel),
    onDownloadProgress: (callback: ProgressCallback): Unsubscribe => subscribe(IPC_CHANNELS.PATHS_MANAGER.DOWNLOAD_PROGRESS, callback),
    onExtractProgress: (callback: ProgressCallback): Unsubscribe => subscribe(IPC_CHANNELS.PATHS_MANAGER.EXTRACT_PROGRESS, callback),
    onCompressProgress: (callback: ProgressCallback): Unsubscribe => subscribe(IPC_CHANNELS.PATHS_MANAGER.COMPRESS_PROGRESS, callback),
    changePerms: (paths: string[], perms: number): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.CHANGE_PERMS, paths, perms),
    copyToIcons: (path: string, name: string): Promise<CustomIconCopyResult> => ipcRenderer.invoke(IPC_CHANNELS.PATHS_MANAGER.COPY_TO_ICONS, path, name)
  },
  gameManager: {
    executeGame: (version: GameVersionType, installation: InstallationType): Promise<GameExecutionResult> => ipcRenderer.invoke(IPC_CHANNELS.GAME_MANAGER.EXECUTE_GAME, version, installation),
    lookForAGameVersion: (path: string): Promise<{ exists: true; installedGameVersion: string } | { exists: false; installedGameVersion?: undefined }> =>
      ipcRenderer.invoke(IPC_CHANNELS.GAME_MANAGER.LOOK_FOR_A_GAME_VERSION, path)
  },
  netManager: {
    queryURL: (url: string): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.NET_MANAGER.QUERY_URL, url),
    acceptModDbVisibility: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.NET_MANAGER.ACCEPT_MODDB_VISIBILITY)
  },
  backgroundsManager: {
    ensureBackground: (id: string, file: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.BACKGROUNDS_MANAGER.ENSURE_BACKGROUND, id, file),
    copyCustomBackground: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.BACKGROUNDS_MANAGER.COPY_CUSTOM_BACKGROUND, path)
  },
  accountManager: {
    login: (email: string, password: string, twoFactorCode?: string): Promise<AccountLoginResult> => ipcRenderer.invoke(IPC_CHANNELS.ACCOUNT_MANAGER.LOGIN, email, password, twoFactorCode),
    removeAccount: (accountId: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.ACCOUNT_MANAGER.REMOVE_ACCOUNT, accountId)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (!process.contextIsolated) throw new Error("Context isolation is required")

try {
  contextBridge.exposeInMainWorld("api", api)
  console.info("[preload] Exposed the launcher API.")
} catch (err) {
  console.error("[preload] Failed to expose the launcher API.")
  throw err
}

export type ApiType = typeof api
