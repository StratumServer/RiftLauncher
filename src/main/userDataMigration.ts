import { constants, realpathSync } from "node:fs"
import { basename, dirname, join, posix, relative, win32 } from "node:path"
import fse from "fs-extra"

import { DEFAULT_CONFIG_BASE } from "@domain/config/defaults"
import {
  DEFAULT_BACKUPS_FOLDER_NAME,
  DEFAULT_INSTALLATIONS_FOLDER_NAME,
  DEFAULT_VERSIONS_FOLDER_NAME,
  holdsPlayerChoice,
  IMPORT_PENDING_MARKER_FILE,
  MIGRATED_USER_DATA_ENTRIES,
  planUserDataMigration
} from "@domain/userData/migrationPlan"
import type { UserDataMigrationAction } from "@domain/userData/migrationPlan"

/** Folder RiftLauncher keeps its own user data in, under the platform's appData. */
export const RIFT_USER_DATA_FOLDER = "RiftLauncher"

/** Marker and profile folder are siblings of the install tree, outside NSIS `$INSTDIR`. */
export const PORTABLE_MARKER_FILE = "RiftLauncher.portable"
export const PORTABLE_USER_DATA_FOLDER = "RiftLauncherData"

/** Folder VS Launcher keeps its user data in. Read from, never written to. */
export const LEGACY_USER_DATA_FOLDER = "VSLauncher"

/** Sibling a migration builds in, renamed onto {@link RIFT_USER_DATA_FOLDER} once complete. */
export const MIGRATION_TEMP_FOLDER = "RiftLauncher.migrating"

/** Portable profile copies are staged beside the destination and renamed into place. */
export const PORTABLE_MIGRATION_TEMP_SUFFIX = ".migrating"

/** What happened, on top of the three planned actions. */
export type UserDataSetupOutcome =
  | UserDataMigrationAction
  | "portable-profile-migrated"
  /** A copy started and did not finish. The launcher starts on an empty folder. */
  | "migration-failed"
  /** No folder was chosen at all, because preparing one failed before the profile was decided. */
  | "unavailable"

export interface UserDataSetup {
  /** Folder to hand to `app.setPath("userData", ...)`. */
  readonly path: string
  readonly outcome: UserDataSetupOutcome
  /** Entries actually copied over, in the order they were copied. */
  readonly copied: readonly string[]
  /** Whether a half-finished copy from an earlier run was thrown away first. */
  readonly cleanedStaleMigration: boolean
  /** Failure details when outcome is "migration-failed". */
  readonly failureReason?: string
  /** Whether a failed import left the marker that makes the next start try again. */
  readonly importPending?: boolean
  /** Set when a temporary copy folder could not be removed; the next start tries again. */
  readonly temporaryFolderLeft?: boolean
}

export interface PortableUserDataPaths {
  readonly markerPath: string
  readonly dataPath: string
  readonly installPath?: string
}

/** Windows path containment is case-insensitive and respects directory boundaries. */
export function isWindowsPathEqualOrWithin(directory: string, candidate: string): boolean {
  const relativePath = win32.relative(win32.resolve(directory), win32.resolve(candidate))
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relativePath))
}

/**
 * Whether a folder or marker belongs to the account running the launcher.
 *
 * Windows has no cheap equivalent (`fs.Stats.uid` is 0 everywhere there and the profile is under
 * the player's own roaming folder anyway), so this is a no-op there and the Windows docs say so.
 * On POSIX a marker or profile folder another account can write is not this player's: adopting it
 * would hand one user a profile, and its logs, to another.
 */
export function isOwnedByThisUser(stats: fse.Stats): boolean {
  const uid = process.getuid?.()
  return uid === undefined || stats.uid === uid
}

/** Chromium rebuilds these from scratch, so a copy that includes them is only slower. */
const REGENERABLE_PROFILE_ENTRIES = [
  "Blob Storage",
  "Code Cache",
  "Component CRX Cache",
  "Crashpad",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "blob_storage",
  "component_crx_cache",
  "crashpad"
]

const REGENERABLE_PROFILE_PATHS = [join("Cache", "Cache_Data"), join("Cache", "No_Vary_Search")]

function portablePathsOverlapInstall(installPath: string, candidatePaths: readonly string[]): boolean {
  const overlaps = (firstPath: string, secondPath: string): boolean => isWindowsPathEqualOrWithin(firstPath, secondPath) || isWindowsPathEqualOrWithin(secondPath, firstPath)
  if (candidatePaths.some((candidatePath) => overlaps(installPath, candidatePath))) return true

  try {
    const realInstallPath = realpathSync.native(installPath)
    return candidatePaths.some((candidatePath) => {
      const realCandidatePath = fse.existsSync(candidatePath) ? realpathSync.native(candidatePath) : win32.join(realpathSync.native(win32.dirname(candidatePath)), win32.basename(candidatePath))
      return overlaps(realInstallPath, realCandidatePath)
    })
  } catch (error) {
    throw new Error(`Could not verify that the portable profile and its migration folder are outside the install folder: ${String(error)}`)
  }
}

/** Finds the opt-in marker beside a Windows install tree or a Linux AppImage. */
export function getPortableUserDataPaths(platform: "win32" | "linux", executablePath: string, appImagePath: string | undefined): PortableUserDataPaths | null {
  if (platform === "win32") {
    if (!win32.isAbsolute(executablePath)) return null
    const installPath = win32.dirname(executablePath)
    const installParent = win32.dirname(installPath)
    return {
      markerPath: win32.join(installParent, PORTABLE_MARKER_FILE),
      dataPath: win32.join(installParent, PORTABLE_USER_DATA_FOLDER),
      installPath
    }
  }

  if (!appImagePath || !posix.isAbsolute(appImagePath)) return null
  const appImageFolder = posix.dirname(appImagePath)
  return {
    markerPath: posix.join(appImageFolder, PORTABLE_MARKER_FILE),
    dataPath: posix.join(appImageFolder, PORTABLE_USER_DATA_FOLDER)
  }
}

/** Throws if a legacy profile path is a symlink, junction or owned by another user. */
function assertTrustedLegacyProfile(legacyPath: string): void {
  const legacyStats = ((): fse.Stats | null => {
    try {
      return fse.lstatSync(legacyPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  })()

  if (legacyStats) {
    if (legacyStats.isSymbolicLink() || !legacyStats.isDirectory()) {
      throw new Error(`Legacy profile is not a folder (link or junction): ${legacyPath}`)
    }
    if (!isOwnedByThisUser(legacyStats)) throw new Error(`Legacy profile belongs to another user: ${legacyPath}`)
  }
}

/** Config copies accept regular files up to 16 MiB, including a config link's target. */
const MAX_MIGRATED_CONFIG_BYTES = 16 * 1024 * 1024

/**
 * Reads a config a migration is about to carry over, refusing anything that is not a regular file
 * of at most 16 MiB.
 *
 * `reportedPath` is the path its messages name. The portable copy reads a temporary copy of the
 * profile, which is deleted before a player could look at it, so that call names the profile's own
 * file instead.
 */
function readMigrationConfig(source: string, reportedPath = source): Buffer {
  const descriptor = fse.openSync(source, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stats = fse.fstatSync(descriptor)
    if (!stats.isFile()) throw new Error(`Config is not a regular file: ${reportedPath}`)
    if (stats.size > MAX_MIGRATED_CONFIG_BYTES) throw new Error(`Config exceeds the 16 MiB migration limit: ${reportedPath}`)
    const contents = Buffer.alloc(stats.size + 1)
    let length = 0
    while (length < contents.length) {
      const count = fse.readSync(descriptor, contents, length, contents.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > stats.size) throw new Error(`Config changed size while it was read: ${reportedPath}`)
    return contents.subarray(0, length)
  } finally {
    fse.closeSync(descriptor)
  }
}

function assertOwnedSourceProfile(profilePath: string): void {
  const stats = fse.statSync(profilePath)
  if (!stats.isDirectory()) throw new Error(`Profile path is not a folder: ${profilePath}`)
  if (!isOwnedByThisUser(stats)) throw new Error(`Profile folder belongs to another user: ${profilePath}`)
}

/** Errors worth waiting out: an antivirus scanner or an indexer holding the freshly copied files. */
const TRANSIENT_MOVE_CODES = new Set(["EACCES", "EPERM", "EBUSY"])
const MOVE_RETRY_WINDOW_MS = 3_000
const FIRST_MOVE_RETRY_DELAY_MS = 50
const MAX_MOVE_RETRY_DELAY_MS = 250

/**
 * `fse.moveSync` through graceful-fs `renameSync`, which unlike the async rename never retries on
 * EPERM, EACCES or EBUSY. The profile is set up before anything else runs, so the wait is
 * synchronous. The returned mover shares one budget of {@link MOVE_RETRY_WINDOW_MS} across every
 * move of a setup, so startup waits that long in total however many entries are moved; the same
 * delays as the config writer's.
 */
function createMoveWithRetry(): (source: string, destination: string, overwrite?: boolean) => void {
  let waited = 0
  let delay = FIRST_MOVE_RETRY_DELAY_MS
  return (source, destination, overwrite = false) => {
    for (;;) {
      try {
        fse.moveSync(source, destination, { overwrite })
        return
      } catch (error) {
        if (!TRANSIENT_MOVE_CODES.has((error as NodeJS.ErrnoException).code ?? "") || waited >= MOVE_RETRY_WINDOW_MS) throw error
        const pause = Math.min(delay, MOVE_RETRY_WINDOW_MS - waited)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause)
        waited += pause
        delay = Math.min(delay * 2, MAX_MOVE_RETRY_DELAY_MS)
      }
    }
  }
}

/**
 * Puts a finished import into a folder an earlier failed import left behind. That folder already
 * holds the logs and Chromium state this launcher wrote since, so the entries go in one by one and
 * the marker goes last: a copy that dies half way is simply tried again. config.json goes right
 * before the marker: once it is VS Launcher's, the first config save of the session looks like a
 * player's own choice and drops the marker, so every other entry has to be in place by then.
 */
function importIntoMarkedFolder(temporaryPath: string, targetPath: string, copied: readonly string[], move: ReturnType<typeof createMoveWithRetry>): void {
  const configLast = [...copied].sort((a, b) => Number(a === "config.json") - Number(b === "config.json"))
  for (const entry of configLast) move(join(temporaryPath, entry), join(targetPath, entry), true)
  fse.removeSync(join(targetPath, IMPORT_PENDING_MARKER_FILE))
  // The import is done by now; the next start cleans a stale temporary folder anyway.
  removeTemporaryFolder(temporaryPath)
}

/**
 * What the failed-import marker in a folder still means, decided now from what is on disk:
 *
 * - `none`: no marker.
 * - `pending`: a marker, and a config.json that is absent or holds nothing the player chose, so
 *   the import still has to happen.
 * - `settled`: a marker, and a config.json that holds a player's choice. The marker is stale (the
 *   save that made the choice could not remove it) and the profile is theirs.
 * - `unreadable`: a marker, and a config.json that cannot be read as a config document (unreadable
 *   file, invalid or truncated JSON, not an object). It may hold anything, so it is never imported
 *   over; the marker stays for a later start that can read it, and the launcher's own recovery
 *   decides what the session runs on.
 *
 * @param folderPath The profile folder.
 * @param defaultFolderRoot Where this profile's session puts the default Installations, versions and backups folders, to tell a default from a changed one.
 */
type ImportMarkerState = "none" | "pending" | "settled" | "unreadable"

function importMarkerState(folderPath: string, defaultFolderRoot: string): ImportMarkerState {
  if (!fse.existsSync(join(folderPath, IMPORT_PENDING_MARKER_FILE))) return "none"
  let document: unknown
  try {
    // The same leading byte order mark strip the config loader does.
    document = JSON.parse(fse.readFileSync(join(folderPath, "config.json"), "utf-8").replace(/^\uFEFF/, ""))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "pending" : "unreadable"
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) return "unreadable"
  const untouched = {
    ...DEFAULT_CONFIG_BASE,
    defaultInstallationsFolder: join(defaultFolderRoot, DEFAULT_INSTALLATIONS_FOLDER_NAME),
    defaultVersionsFolder: join(defaultFolderRoot, DEFAULT_VERSIONS_FOLDER_NAME),
    backupsFolder: join(defaultFolderRoot, DEFAULT_BACKUPS_FOLDER_NAME)
  }
  return holdsPlayerChoice(document as Record<string, unknown>, untouched) ? "settled" : "pending"
}

/** Removes a stale marker. Best effort: a marker that stays is read as stale again at the next start. */
function dropStaleMarker(folderPath: string): void {
  try {
    fse.removeSync(join(folderPath, IMPORT_PENDING_MARKER_FILE))
  } catch {
    /* a scanner holding the file: the next start reads it as stale again */
  }
}

/** Leaves the empty folder a failed import ends on, with the marker that makes the next start try again. Whether the marker could be written. */
function leaveMarkedEmptyFolder(folderPath: string): boolean {
  fse.ensureDirSync(folderPath)
  try {
    fse.writeFileSync(join(folderPath, IMPORT_PENDING_MARKER_FILE), "")
    return true
  } catch {
    return false
  }
}

/**
 * Removes a temporary copy folder, and says whether it is gone. fs-extra's `removeSync` does not
 * wait out a lock, and the scanner that holds a copy long enough to fail the rename holds it for
 * this too: a leftover must never stop the launcher from starting, the next start cleans it.
 */
function removeTemporaryFolder(folderPath: string): boolean {
  try {
    fse.removeSync(folderPath)
  } catch {
    /* best effort: whether it is gone is checked below */
  }
  return !fse.existsSync(folderPath)
}

/** What a copy into a path that still holds an earlier, unremovable leftover would mix in. */
function staleFolderError(folderPath: string): Error {
  return new Error(`A temporary folder from an earlier start could not be removed: ${folderPath}`)
}

function copyLegacyUserDataEntries(legacyPath: string, temporaryPath: string, entries: readonly string[]): string[] {
  const copied: string[] = []
  for (const entry of entries) {
    const source = join(legacyPath, entry)
    try {
      fse.lstatSync(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }

    const destination = join(temporaryPath, entry)
    if (entry === "config.json") {
      try {
        fse.writeFileSync(destination, readMigrationConfig(source))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
    } else {
      fse.copySync(source, destination, {
        filter: (sourceEntry) => {
          if (!fse.lstatSync(sourceEntry).isSymbolicLink()) return true
          throw new Error(`Legacy profile contains a symbolic link that cannot be copied safely: ${relative(legacyPath, sourceEntry)}`)
        }
      })
    }
    copied.push(entry)
  }
  return copied
}

/**
 * Picks the user-data folder and carries VS Launcher's data over the first time.
 *
 * Runs synchronously and before anything else, because `app.setPath` has to be
 * called before the logger, the config manager or any handler reads `userData`.
 *
 * The copy lands in a temporary sibling and is renamed into place as the last
 * step, so an interrupted run leaves a folder that is obviously incomplete
 * rather than a RiftLauncher folder that looks migrated and is not. The next
 * run deletes that leftover and starts over.
 *
 * The VS Launcher folder is only ever read. An installed VS Launcher keeps
 * every byte it had, and a player can go back to it at any time.
 *
 * @param appDataPath The platform's roaming application-data folder.
 * @returns The folder to use and what was done to get there.
 */
export function setUpUserDataFolder(appDataPath: string): UserDataSetup {
  const riftPath = join(appDataPath, RIFT_USER_DATA_FOLDER)
  const legacyPath = join(appDataPath, LEGACY_USER_DATA_FOLDER)
  const temporaryPath = join(appDataPath, MIGRATION_TEMP_FOLDER)

  const riftExists = fse.existsSync(riftPath)
  const markerState = riftExists ? importMarkerState(riftPath, appDataPath) : "none"
  const plan = planUserDataMigration({
    riftExists,
    riftImportPending: markerState === "pending",
    vslExists: fse.existsSync(legacyPath),
    staleMigrationExists: fse.existsSync(temporaryPath)
  })

  const staleGone = !plan.cleanStaleMigration || removeTemporaryFolder(temporaryPath)
  const cleanedStaleMigration = plan.cleanStaleMigration && staleGone
  const staleLeft = staleGone ? {} : { temporaryFolderLeft: true }

  // Outside the try below on purpose: a folder this player does not own is neither used nor
  // written to, not even to leave a marker in it.
  if (riftExists) assertOwnedSourceProfile(realpathSync.native(riftPath))
  if (markerState === "settled") dropStaleMarker(riftPath)

  if (plan.action !== "migrate") {
    fse.ensureDirSync(riftPath)
    return { path: riftPath, outcome: plan.action, copied: [], cleanedStaleMigration, ...staleLeft }
  }

  try {
    assertTrustedLegacyProfile(legacyPath)
    if (!staleGone) throw staleFolderError(temporaryPath)
    fse.ensureDirSync(temporaryPath)
    const copied = copyLegacyUserDataEntries(legacyPath, temporaryPath, plan.copy)
    const moveWithRetry = createMoveWithRetry()
    if (riftExists) importIntoMarkedFolder(temporaryPath, riftPath, copied, moveWithRetry)
    else moveWithRetry(temporaryPath, riftPath)
    return { path: riftPath, outcome: "migrate", copied, cleanedStaleMigration }
  } catch (error) {
    // A migration that cannot finish must not stop the launcher from starting. The leftover goes
    // and the player gets an empty folder, with a marker in it so the next start tries again from
    // VS Launcher's folder, which was only ever read. A refusal to read a linked or foreign-owned
    // legacy folder lands here too: retrying it costs one lstat and one log line per start.
    const temporaryGone = removeTemporaryFolder(temporaryPath)
    const importPending = leaveMarkedEmptyFolder(riftPath)
    const failureReason = error instanceof Error ? error.message : String(error)
    return { path: riftPath, outcome: "migration-failed", copied: [], cleanedStaleMigration, failureReason, importPending, ...(temporaryGone ? {} : { temporaryFolderLeft: true }) }
  }
}

function migratePortableDefaultFolders(profilePath: string, sourceProfilePath: string, appDataPath: string, dataPath: string): void {
  const folderDefaults = [
    ["defaultInstallationsFolder", DEFAULT_INSTALLATIONS_FOLDER_NAME],
    ["defaultVersionsFolder", DEFAULT_VERSIONS_FOLDER_NAME],
    ["backupsFolder", DEFAULT_BACKUPS_FOLDER_NAME]
  ] as const

  for (const fileName of ["config.json", "config.pre-migration.bak.json"]) {
    const configPath = join(profilePath, fileName)
    let isSymbolicLink: boolean
    try {
      isSymbolicLink = fse.lstatSync(configPath).isSymbolicLink()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }

    const contents = readMigrationConfig(isSymbolicLink ? join(sourceProfilePath, fileName) : configPath, join(sourceProfilePath, fileName))
    let output: Buffer | string = contents
    let changed = false
    try {
      // A config.json written by an editor on Windows can start with a BOM, and JSON.parse rejects
      // it, which would silently leave the old default folders in place after the profile moved.
      const parsed: unknown = JSON.parse(contents.toString("utf8").replace(/^\uFEFF/, ""))
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const config = parsed as Record<string, unknown>
        for (const [key, folderName] of folderDefaults) {
          if (config[key] !== join(appDataPath, folderName)) continue
          config[key] = join(dataPath, folderName)
          changed = true
        }
        if (changed) output = JSON.stringify(config, null, 2) + "\n"
      }
    } catch {
      // Keep an unreadable snapshot byte for byte; startup recovery handles it later.
    }

    if (isSymbolicLink) fse.unlinkSync(configPath)
    if (changed || isSymbolicLink) fse.writeFileSync(configPath, output)
  }
}

/**
 * Sets up a profile selected by the portable marker. Existing RiftLauncher data
 * is copied except for regenerable Chromium caches; saved background images stay
 * with the profile. The older VS Launcher migration stays limited to its existing
 * config-and-icons allowlist.
 */
export function setUpPortableUserDataFolder(appDataPath: string, dataPath: string, installPath?: string): UserDataSetup {
  const currentProfilePath = join(appDataPath, RIFT_USER_DATA_FOLDER)
  const legacyProfilePath = join(appDataPath, LEGACY_USER_DATA_FOLDER)
  const temporaryPath = `${dataPath}${PORTABLE_MIGRATION_TEMP_SUFFIX}`
  if (installPath && portablePathsOverlapInstall(installPath, [dataPath, temporaryPath])) {
    throw new Error("Portable profile or migration folder overlaps the NSIS install folder. Rename the install folder so updates cannot delete it.")
  }

  const hadStaleMigration = fse.existsSync(temporaryPath)
  const staleGone = !hadStaleMigration || removeTemporaryFolder(temporaryPath)
  const cleanedStaleMigration = hadStaleMigration && staleGone
  const staleLeft = staleGone ? {} : { temporaryFolderLeft: true }

  // A default folder that still waits for its import (the marker, and a config.json holding nothing
  // the player chose) has no player data in it, so VS Launcher's folder is imported instead.
  const defaultIsMarked = importMarkerState(currentProfilePath, appDataPath) === "pending"
  const hasCurrentProfile = fse.existsSync(currentProfilePath) && !defaultIsMarked
  const hasLegacyProfile = !hasCurrentProfile && fse.existsSync(legacyProfilePath)

  // lstat, not stat: a link pointing at a folder elsewhere is not a portable profile, and a
  // profile folder owned by another account is not this player's either.
  const existingData = ((): fse.Stats | null => {
    try {
      return fse.lstatSync(dataPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  })()

  // A portable folder an earlier failed import left with the marker in it, while VS Launcher's
  // folder is still there to import from: not set up yet, so the import is tried again into it.
  let markedPortableFolder = false
  if (existingData) {
    if (!existingData.isDirectory()) throw new Error(`Portable data path is not a folder: ${dataPath}`)
    if (!isOwnedByThisUser(existingData)) throw new Error(`Portable data folder belongs to another user: ${dataPath}`)
    const entries = fse.readdirSync(dataPath)
    const markerState = importMarkerState(dataPath, dataPath)
    markedPortableFolder = hasLegacyProfile && markerState === "pending"
    if (!markedPortableFolder) {
      if (markerState === "settled") dropStaleMarker(dataPath)
      if (entries.length > 0) return { path: dataPath, outcome: "use-existing", copied: [], cleanedStaleMigration, ...staleLeft }
      fse.removeSync(dataPath)
    }
  }

  if (!hasCurrentProfile && !hasLegacyProfile) {
    fse.ensureDirSync(dataPath)
    return { path: dataPath, outcome: "fresh", copied: [], cleanedStaleMigration, ...staleLeft }
  }

  const copied: string[] = []
  try {
    if (!staleGone) throw staleFolderError(temporaryPath)
    if (hasCurrentProfile) {
      const sourceProfilePath = realpathSync.native(currentProfilePath)
      assertOwnedSourceProfile(sourceProfilePath)

      fse.copySync(sourceProfilePath, temporaryPath, {
        filter: (source) => {
          const profileEntry = relative(sourceProfilePath, source)
          const entryName = basename(source)
          if (dirname(profileEntry) === "." && REGENERABLE_PROFILE_ENTRIES.includes(entryName)) return false
          if (REGENERABLE_PROFILE_PATHS.includes(profileEntry)) return false
          if (!fse.lstatSync(source).isSymbolicLink()) return true
          if (profileEntry === "config.json" || profileEntry === "config.pre-migration.bak.json") return true
          if (["SingletonLock", "SingletonCookie", "SingletonSocket"].includes(entryName)) return false
          throw new Error(`Profile contains a symbolic link that cannot be copied safely: ${profileEntry}`)
        }
      })
      migratePortableDefaultFolders(temporaryPath, sourceProfilePath, appDataPath, dataPath)
    } else {
      assertTrustedLegacyProfile(legacyProfilePath)
      fse.ensureDirSync(temporaryPath)
      copied.push(...copyLegacyUserDataEntries(legacyProfilePath, temporaryPath, MIGRATED_USER_DATA_ENTRIES))
    }

    const moveWithRetry = createMoveWithRetry()
    if (markedPortableFolder) importIntoMarkedFolder(temporaryPath, dataPath, copied, moveWithRetry)
    else moveWithRetry(temporaryPath, dataPath)
  } catch (error) {
    const temporaryGone = removeTemporaryFolder(temporaryPath)
    // Importing from VS Launcher only because the default folder holds the marker, or because this
    // portable folder does, is a retry of an import that already failed once: it must not stop the
    // launcher, which starts on an empty portable profile and tries again next time. Any other
    // failed copy still stops the launcher, so a player's data is never split silently.
    if (!hasLegacyProfile || !(defaultIsMarked || markedPortableFolder)) throw new Error(`Could not copy the existing profile to the portable data folder: ${String(error)}`)
    const failureReason = error instanceof Error ? error.message : String(error)
    return {
      path: dataPath,
      outcome: "migration-failed",
      copied: [],
      cleanedStaleMigration,
      failureReason,
      importPending: leaveMarkedEmptyFolder(dataPath),
      ...(temporaryGone ? {} : { temporaryFolderLeft: true })
    }
  }

  return {
    path: dataPath,
    outcome: hasCurrentProfile ? "portable-profile-migrated" : "migrate",
    copied,
    cleanedStaleMigration
  }
}

/** One line for the startup log, describing what {@link setUpUserDataFolder} did. */
export function describeUserDataSetup(setup: UserDataSetup): string {
  const stale =
    (setup.cleanedStaleMigration ? " Discarded an unfinished migration from an earlier run." : "") +
    (setup.temporaryFolderLeft ? " A temporary copy folder could not be removed and is cleaned at the next start." : "")

  switch (setup.outcome) {
    case "use-existing":
      return `Using the existing RiftLauncher user data folder.${stale}`
    case "migrate":
      return `Copied ${setup.copied.length > 0 ? setup.copied.join(", ") : "nothing"} from the VS Launcher user data folder, which was left untouched.${stale}`
    case "portable-profile-migrated":
      return `Copied the existing RiftLauncher profile to the portable data folder; the original was left untouched.${stale}`
    case "migration-failed":
      return `Could not copy the VS Launcher user data folder${setup.failureReason ? ` (${setup.failureReason})` : ""}. Starting on an empty RiftLauncher folder${setup.importPending ? ", and trying the import again at the next start" : ""}.${stale}`
    case "fresh":
      return `Created a new RiftLauncher user data folder.${stale}`
    case "unavailable":
      return `No RiftLauncher user data folder was prepared.${stale}`
  }
}
