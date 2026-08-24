declare global {
  type BasicConfigType = {
    /** Schema of the stored config, an integer counting schemas. Never the app version. See src/domain/config/migrations.ts. */
    schemaVersion: number
    lastUsedInstallation: string | null
    defaultInstallationsFolder: string
    defaultVersionsFolder: string
    backupsFolder: string
    favMods: number[]
    /**
     * Modids (the string id a Mod declares, not the ModDB numeric one) the player has held back:
     * Update All leaves them alone until the suspension is lifted, one row at a time.
     *
     * Known limit: launcher-wide, not per installation. Same shape as favMods, and a modid held at an
     * older version in one Installation is normally held in every other. Move it onto the
     * Installation if someone actually needs the two to disagree.
     */
    suspendedModUpdates: string[]
    /**
     * Which background the launcher paints: `default` for the bundled scene, `custom` for the
     * player's own picture, or a catalog id off the repository's `backgrounds` branch. See
     * src/domain/backgrounds.ts.
     */
    background: string
    _notifiedModUpdatesInstallations?: string[]
    /**
     * Bumped by every background selection so a re-pick of the same id still repaints. The custom
     * slot keeps one stable file name, so without this the CSS URL would not change and the
     * renderer would keep showing the picture that name used to hold. Session-only, like
     * `_notifiedModUpdatesInstallations`: normalizeConfig never writes it back out.
     */
    _backgroundRevision?: number
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
    /**
     * Null for an account with no entitlements (a live `gamelogin` response
     * answers `entitlements: null` for one), not just absent or unusable. The
     * game's own client sets `ClientSettings.Entitlements` straight from the
     * response, so null is a value it already handles, not a launcher-only
     * concept. See src/domain/account/credentials.ts.
     */
    playerEntitlements: string | null
    hostGameServer: boolean
  }

  // Renderer-visible account data. Session credentials are main-process only.
  type AccountType = AccountPublicType

  /**
   * LOGIN's verdict once the domain's own verdict (src/domain/account/login.ts
   * LoginVerdict) has been mapped onto the wire.
   *
   * `unexpected-response` is honesty, not a stand-in for bad credentials: the
   * service claimed success but the launcher could not read the body it sent
   * back, so the player's password was never actually rejected. Collapsing
   * that case into `invalid-credentials` is exactly the bug this type exists
   * to make impossible again.
   */
  type AccountLoginResult =
    | { status: "success"; account: AccountPublicType }
    | { status: "invalid-credentials" | "requires-two-factor" | "wrong-two-factor" | "unexpected-response"; account?: undefined }

  type GameVersionType = {
    version: string
    path: string
    /** Registered from a folder the launcher did not install, so removing it must only unregister it. */
    linked?: boolean
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
    homepageurl: string | null
    sourcecodeurl: string | null
    downloads: number
    follows: number
    trendingpoints: number
    comments: number
    side: string
    createdat: string
    tags: string[]
    releases: DownloadableModReleaseType[]
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

  /** One scene as the `backgrounds` branch manifest lists it. `file` is its name on that branch. */
  type BackgroundType = {
    id: string
    name: string
    file: string
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

  /**
   * Why EXECUTE_GAME never started the game. Every value here is a refusal a
   * player can reach through normal use, not an attack: those are still
   * thrown (see assertTrustedIpcSender, validateGameVersion,
   * validateGameInstallation, assertManagedPath in src/ipc), which rejects the
   * invoke() promise instead of resolving with a reason.
   *
   * - `unsupported-platform` / `no-executable`: {@link BuildGameLaunchPlanFailure}.
   * - `session-write-failed`: the account session could not be written into
   *   the installation's clientsettings.json (unreadable or unwritable file).
   * - `launch-failed`: the executable failed its last check before spawning,
   *   or the spawn itself failed.
   * - `invalid-request`: the installation's own start environment variables
   *   could not be parsed. Reachable by typing garbage into an installation's
   *   settings, not by an attacker on the IPC channel.
   */
  type GameExecutionFailureReason = "unsupported-platform" | "no-executable" | "session-write-failed" | "launch-failed" | "invalid-request"

  /**
   * EXECUTE_GAME's verdict.
   *
   * `ok: true` resolves once the game exits, however long the play session
   * takes and whatever exit code it leaves with: a non-zero exit code is not
   * read as a launch failure, since Vintage Story exits non-zero often enough
   * that treating it as one would blame a player for closing their own game.
   * `ok: false` means the game never ran at all.
   */
  type GameExecutionResult = { ok: true; exitCode: number | null } | { ok: false; reason: GameExecutionFailureReason }

  /**
   * Why RUN_INSTALLER never finished, narrowed to what the handler can
   * actually tell apart today (see src/ipc/handlers/pathsHandlers.ts and its
   * installerTimeoutOutcome.ts helpers). The extraction-vs-spawn mechanics
   * behind RUN_INSTALLER stay internal: both count as `ok` when they land the
   * game, and these reasons only describe how it failed.
   *
   * - `not-windows`: the host is not Windows, so RUN_INSTALLER never runs the
   *   installer at all.
   * - `installer-missing`: the installer file at the given path does not
   *   exist.
   * - `installer-timed-out`: the fallback spawn ran past its bound and had
   *   its process tree killed. Only that direct-spawn path tracks this; a
   *   payload-extraction attempt that runs long resolves `installer-failed`
   *   instead, indistinguishable from any other extraction failure.
   * - `installer-failed`: payload extraction failed outright, or the
   *   fallback spawn errored on launch, exited non-zero, or could not be
   *   started.
   */
  type InstallerRunFailureReason = "installer-failed" | "installer-timed-out" | "not-windows" | "installer-missing"

  /** RUN_INSTALLER's verdict. `ok: false` means nothing was installed. */
  type InstallerRunResult = { ok: true } | { ok: false; reason: InstallerRunFailureReason }

  /**
   * Why SAVE_CONFIG refused to persist the config it was handed. The
   * renderer sends the whole config on every change; a persistent refusal
   * here used to be invisible, silently discarding every setting,
   * installation and backup record the player touched afterward.
   *
   * - `invalid-payload`: the argument was not even an object. Not reachable
   *   from the launcher's own UI, which always sends the config it holds in
   *   state; a defensive check against a malformed IPC call.
   * - `unauthorized-path`: `assertConfigPathsAuthorized` refused because the
   *   incoming config points at a folder outside the paths the launcher
   *   already manages, and the player has not approved it either. The most
   *   likely real-world cause: a folder picked, moved, or edited outside the
   *   launcher's own dialogs.
   * - `write-failed`: `saveConfig` queued the write and it threw (the
   *   temp-file write or the rename onto `config.json` failed), which
   *   `saveConfig` catches and reports as `false`. Disk full, permissions,
   *   or something else holding the file.
   */
  type SaveConfigFailureReason = "invalid-payload" | "unauthorized-path" | "write-failed"

  /** SAVE_CONFIG's verdict. `ok: false` means nothing was written to disk. */
  type SaveConfigResult = { ok: true } | { ok: false; reason: SaveConfigFailureReason }

  /**
   * Why COPY_TO_ICONS refused to put a picked file in the Icons folder. Every
   * gate there used to answer a bare `{ status: false }` and write nothing to
   * the log, so eight different refusals reached the player as one sentence
   * that named none of them (#202).
   *
   * - `unsupported-format`: the picked file is not a PNG. The extension is
   *   matched case-insensitively, so `.PNG` is a png like any other, and the
   *   first eight bytes have to be the PNG signature too, so a file renamed to
   *   `.png` is refused the same way the background flow refuses a `.jpg` that
   *   is not a JPEG (#211).
   * - `source-unavailable`: the path policy refused the picked file, or it is
   *   gone, or a folder on the way to it is a symbolic link. Nothing was read.
   * - `copy-failed`: the file was readable and the write still failed. A
   *   folder or a symlink already sitting on the destination name, no
   *   permission to read the source, a full disk.
   */
  type CustomIconCopyFailureReason = "unsupported-format" | "source-unavailable" | "copy-failed"

  /** COPY_TO_ICONS' verdict. `status: false` means nothing was written to the Icons folder. */
  type CustomIconCopyResult = { status: true; file: string } | { status: false; reason: CustomIconCopyFailureReason }

  declare module "*.png" {
    const value: string
    export default value
  }

  declare module "*.jpg" {
    const value: string
    export default value
  }
}

export {}
