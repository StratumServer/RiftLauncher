declare global {
  type BasicConfigType = {
    /** Schema of the stored config, an integer counting schemas. Never the app version. See src/domain/config/migrations.ts. */
    schemaVersion: number
    lastUsedInstallation: string | null
    defaultInstallationsFolder: string
    defaultVersionsFolder: string
    backupsFolder: string
    favMods: number[]
    _notifiedModUpdatesInstallations?: string[]
  }

  type WindowType = {
    width: number
    height: number
    x: number
    y: number
    maximized: boolean
  }

  type AccountPublicType = {
    email: string
    playerName: string
    playerUid: string
    playerEntitlements: string
    hostGameServer: boolean
  }

  // Renderer-visible account data. Session credentials are main-process only.
  type AccountType = AccountPublicType

  type GameVersionType = {
    version: string
    path: string
    _installing?: boolean
    _deleting?: boolean
    _playing?: boolean
  }

  type BackupType = {
    id: string
    date: number
    path: string
    _deleting?: boolean
    _restoring?: boolean
  }

  type InstallationType = {
    id: string
    name: string
    icon: string
    path: string
    version: string
    startParams: string
    backupsLimit: number
    backupsAuto: boolean
    compressionLevel: number
    backups: BackupType[]
    lastTimePlayed: number
    totalTimePlayed: number
    mesaGlThread: boolean
    envVars: string
    _modsCount?: number
    _playing?: boolean
    _backuping?: boolean
    _restoringBackup?: boolean
    _updatingMods?: boolean
  }

  type ConfigType = BasicConfigType & {
    window: WindowType
    account: AccountPublicType | null
    installations: InstallationType[]
    gameVersions: GameVersionType[]
    customIcons: IconType[]
  }

  type InstalledModType = {
    name: string
    modid: string
    version: string
    path: string
    description?: string
    side?: string
    authors?: string[]
    contributors?: string[]
    type?: string
    _image?: string
    _mod?: DownloadableModType
    _updatableTo?: string
    _lastVersion?: string
  }

  type ErrorInstalledModType = { zipname: string; path: string }

  type DownloadableModOnListType = {
    modid: number
    assetid: number
    downloads: number
    follows: number
    trendingpoints: number
    comments: number
    name: string
    summary: string | null
    modidstrs: string[]
    author: string
    urlalias: string | null
    side: string
    type: string
    logo: string
    tags: string[]
    lastreleased: string
  }

  type DownloadableModType = {
    modid: number
    assetid: number
    name: string
    text: string
    author: string
    urlalias: string | null
    logofilename: string | null
    logofile: string | null
    homepageurl: string | null
    sourcecodeurl: string | null
    trailervideourl: string | null
    issuetrackerurl: string | null
    wikiurl: string | null
    downloads: number
    follows: number
    trendingpoints: number
    comments: number
    side: string
    tuype: string
    createdat: string
    lasmodified: string
    tags: string[]
    releases: DownloadableModReleaseType[]
    screenshots: DownloadableModScreenshotType[]
  }

  type DownloadableModScreenshotType = {
    fileid: number
    mainfile: string
    filename: string
    thumbnailfile: string
    createdat: string
  }

  type DownloadableModReleaseType = {
    releaseid: number
    mainfile: string
    filename: string
    fileid: number
    downloads: number
    tags: string[]
    modidstr: string
    modversion: string
    created: string
    changelog: string
  }

  /** One platform's build as the version catalog serves it: the URL and the real file name. */
  type DownloadableGameVersionBuildType = {
    url: string
    fileName: string
  }

  type DownloadableGameVersionTypeType = {
    version: string
    type: "stable" | "rc" | "pre"
    windows: DownloadableGameVersionBuildType
    linux: DownloadableGameVersionBuildType
    mac: DownloadableGameVersionBuildType
  }

  type DownloadableModAuthorType = {
    userid: string
    name: string
  }

  type DownloadableModGameVersionType = {
    tagid: string
    name: string
    color: string
  }

  type DownloadableModTagType = {
    tagid: number
    name: string
    color: string
  }

  type IconType = {
    id: string
    name: string
    icon: string
    custom?: boolean
  }

  type ModpackModEntryType = {
    modid: string
    version: string
  }

  type ModpackManifestType = {
    name: string
    gameVersion: string
    mods: ModpackModEntryType[]
  }

  type ModChangeSummaryEntry = {
    name: string
    modid: string
    fromVersion: string | null
    toVersion: string | null
    assetid?: number
    alreadyPresent?: boolean
  }

  declare module "*.png" {
    const value: string
    export default value
  }
}

export {}
