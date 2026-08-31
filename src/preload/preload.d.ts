declare global {
  type ProgressCallback = {
    (payload: { id: string; progress: number }): void
  }

  /** The update the main process found and is offering, before anything has been downloaded. */
  type UpdateAvailableCallback = {
    (payload: { version: string; releaseName?: string }): void
  }

  /** One tick of the accepted launcher update's download, as a whole percentage. */
  type UpdateProgressCallback = {
    (payload: { version: string; progress: number }): void
  }

  type Unsubscribe = () => void

  type BridgeAPI = {
    utils: {
      getAppVersion: () => Promise<string>
      getOs: () => Promise<NodeJS.Platform>
      logMessage: (mode: ErrorTypes, message: string) => void
      setPreventAppClose: (action: "add" | "remove", id: string, desc: string) => void
      openOnBrowser: (url: string) => void
      selectFolderDialog: (options?: { type?: "file" | "folder"; mode?: "single" | "multi"; extensions?: string[] }) => Promise<string[]>
      onPreventedAppClose: (callback: () => void) => Unsubscribe
    }
    appUpdater: {
      onUpdateAvailable: (callback: UpdateAvailableCallback) => Unsubscribe
      onUpdateDownloadProgress: (callback: UpdateProgressCallback) => Unsubscribe
      onUpdateError: (callback: () => void) => Unsubscribe
      onUpdateDownloaded: (callback: () => void) => Unsubscribe
      downloadUpdate: () => void
      updateAndRestart: () => void
    }
    configManager: {
      getConfig: () => Promise<ConfigType>
      saveConfig: (configJson: ConfigType) => Promise<SaveConfigResult>
    }
    modsManager: {
      getInstalledMods: (path: string) => Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }>
      exportModpack: (manifest: ModpackManifestType) => Promise<{ success: boolean; path?: string }>
      importModpack: () => Promise<{ success: boolean; manifest?: ModpackManifestType; error?: string }>
      clearModIconMemoryCache: () => void
    }
    pathsManager: {
      getCurrentUserDataPath: () => Promise<string>
      formatPath: (parts: string[]) => Promise<string>
      removeFileFromPath(path: string): Promise<string>
      deletePath: (path: string) => Promise<boolean>
      movePath: (fromPath: string, toPath: string) => Promise<boolean>
      checkPathEmpty: (path: string) => Promise<boolean>
      checkPathExists: (path: string) => Promise<boolean>
      ensurePathExists: (path: string) => Promise<boolean>
      openPathOnFileExplorer: (path: string) => Promise<void>
      downloadOnPath: (id: string, url: string, outputPath: string, fileName: string) => Promise<string>
      extractOnPath: (id: string, filePath: string, outputPath: string, deleteZip: boolean, unwrapSingleRootFolder?: boolean) => Promise<boolean>
      runInstaller: (id: string, filePath: string, outputPath: string, deleteInstaller: boolean) => Promise<InstallerRunResult>
      compressOnPath: (id: string, inputPath: string, outputPath: string, outputFileName: string, compressionLevel?: number) => Promise<boolean>
      onDownloadProgress: (callback: ProgressCallback) => Unsubscribe
      onExtractProgress: (callback: ProgressCallback) => Unsubscribe
      onCompressProgress: (callback: ProgressCallback) => Unsubscribe
      changePerms: (paths: string[], perms: number) => Promise<boolean>
      copyToIcons: (path: string, name: string) => Promise<CustomIconCopyResult>
    }
    gameManager: {
      executeGame: (version: GameVersionType, installation: InstallationType) => Promise<GameExecutionResult>
      lookForAGameVersion: (path: string) => Promise<{ exists: true; installedGameVersion: string } | { exists: false; installedGameVersion?: undefined }>
    }
    netManager: {
      queryURL: (url: string) => Promise<string>
      /**
       * Records the accepted answer to the one-time ModDB listing question and, once it is on
       * disk, requests the listing archive once, which registers one download there. True when the
       * answer was written; false means nothing was written and nothing was requested, so the
       * question survives to the next launch. The request itself never fails out loud: it is the
       * player's courtesy going unnoticed, not their problem.
       */
      acceptModDbVisibility: () => Promise<boolean>
    }
    backgroundsManager: {
      /** Downloads one catalog scene into the cache if it is not already there. False if it could not be. */
      ensureBackground: (id: string, file: string) => Promise<boolean>
      /** Copies the player's own picture into the cache under the reserved custom name. */
      copyCustomBackground: (path: string) => Promise<boolean>
    }
    accountManager: {
      login: (email: string, password: string, twoFactorCode?: string) => Promise<AccountLoginResult>
      /** Drops one saved account's secrets, by its `playerUid`. */
      removeAccount: (accountId: string) => Promise<boolean>
    }
  }

  interface Window {
    api: BridgeAPI
  }

  type ErrorTypes = "error" | "warn" | "info" | "debug" | "verbose"
}

export {}
