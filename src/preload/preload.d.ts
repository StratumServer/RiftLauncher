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
      /** Writes one short string to the system clipboard, answering whether it landed. */
      copyToClipboard: (text: string) => Promise<boolean>
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
      getInstalledMods: (path: string) => Promise<InstalledModsScan>
      /** Reads the Installation's ModsByServer tree. The host names the folder; this only names the Installation. */
      getServerMods: (installationPath: string) => Promise<ServerModsScan>
      setModEnabled: (path: string, enabled: boolean) => Promise<SetModEnabledResult>
      cacheModImage: (url: string) => Promise<string | undefined>
      exportModpack: (manifest: ModpackManifestType) => Promise<{ success: boolean; path?: string }>
      importModpack: () => Promise<{ success: boolean; manifest?: ModpackManifestType; error?: string }>
      clearModIconMemoryCache: () => void
      getModProfiles: (installationPath: string) => Promise<ModProfilesReadResult>
      saveModProfiles: (installationPath: string, document: ModProfilesDocument) => Promise<ModProfilesSaveResult>
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
      /**
       * `serverId` names one of the Installation's OWN stored bookmarks. It is never an address:
       * the main process looks the id up in the config it already holds and builds the URL from
       * the record it finds, so nothing typed in the renderer can reach the game's argv.
       */
      executeGame: (version: GameVersionType, installation: InstallationType, serverId?: string) => Promise<GameExecutionResult>
      lookForAGameVersion: (path: string) => Promise<{ exists: true; installedGameVersion: string; variant?: GameBuildVariantType } | { exists: false; installedGameVersion?: undefined }>
      /** The play sessions recorded for one Installation, newest first. Read only: nothing writes samples from here. */
      getPlaySessions: (installationId: string) => Promise<PlaySessionsReadResult>
      /** Clears one Installation's recorded sessions. */
      forgetPlaySessions: (installationId: string) => Promise<{ ok: boolean }>
      /** Reads the last session's own log files out of one Installation and answers the report built from them. See #462. */
      getGameLogReport: (installationPath: string) => Promise<GameLogReportResult>
    }
    netManager: {
      queryURL: (url: string) => Promise<string>
      /**
       * Records the player's answer to the ModDB listing question and, once it is on disk, counts
       * the running version on the listing when that answer says to. `consent` is the answer they
       * just gave, or null for the silent count a stored "always" owes this launch.
       *
       * Answers a reason token and the state the main process wrote, which the renderer mirrors so
       * the two copies of the config agree on what has been counted. The request itself never
       * fails out loud: it is the player's courtesy going unnoticed, not their problem.
       */
      countModDbDownload: (consent: ModDbVisibilityConsentValue | null) => Promise<ModDbCountResult>
      /** Fetches this repository's GitHub releases, for the "what's new" dialog and the Info & Help page. See src/domain/appUpdate/whatsNew.ts. */
      fetchReleaseNotes: () => Promise<FetchReleaseNotesResult>
    }
    backgroundsManager: {
      /** Downloads one catalog scene into the cache when it is missing or its manifest hash changed, and reports what it did. */
      ensureBackground: (id: string, file: string, sha256?: string) => Promise<EnsureBackgroundResult>
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
