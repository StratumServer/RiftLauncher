import { constants, realpathSync } from "node:fs"
import { basename, dirname, join, posix, relative, win32 } from "node:path"
import fse from "fs-extra"

import { DEFAULT_BACKUPS_FOLDER_NAME, DEFAULT_INSTALLATIONS_FOLDER_NAME, DEFAULT_VERSIONS_FOLDER_NAME, MIGRATED_USER_DATA_ENTRIES, planUserDataMigration } from "@domain/userData/migrationPlan"
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

  const plan = planUserDataMigration({
    riftExists: fse.existsSync(riftPath),
    vslExists: fse.existsSync(legacyPath),
    staleMigrationExists: fse.existsSync(temporaryPath)
  })

  if (plan.cleanStaleMigration) fse.removeSync(temporaryPath)

  if (plan.action !== "migrate") {
    if (plan.action === "use-existing") assertOwnedSourceProfile(realpathSync.native(riftPath))
    fse.ensureDirSync(riftPath)
    return { path: riftPath, outcome: plan.action, copied: [], cleanedStaleMigration: plan.cleanStaleMigration }
  }

  try {
    assertTrustedLegacyProfile(legacyPath)
    fse.ensureDirSync(temporaryPath)
    const copied = copyLegacyUserDataEntries(legacyPath, temporaryPath, plan.copy)
    fse.moveSync(temporaryPath, riftPath)
    return { path: riftPath, outcome: "migrate", copied, cleanedStaleMigration: plan.cleanStaleMigration }
  } catch (error) {
    // A migration that cannot finish must not stop the launcher from starting.
    // The leftover goes, the player gets an empty folder, and deleting the empty
    // RiftLauncher folder allows retrying once the issue is resolved.
    fse.removeSync(temporaryPath)
    fse.ensureDirSync(riftPath)
    const failureReason = error instanceof Error ? error.message : String(error)
    return { path: riftPath, outcome: "migration-failed", copied: [], cleanedStaleMigration: plan.cleanStaleMigration, failureReason }
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

  const cleanedStaleMigration = fse.existsSync(temporaryPath)

  if (cleanedStaleMigration) fse.removeSync(temporaryPath)

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

  if (existingData) {
    if (!existingData.isDirectory()) throw new Error(`Portable data path is not a folder: ${dataPath}`)
    if (!isOwnedByThisUser(existingData)) throw new Error(`Portable data folder belongs to another user: ${dataPath}`)
    if (fse.readdirSync(dataPath).length > 0) {
      return { path: dataPath, outcome: "use-existing", copied: [], cleanedStaleMigration }
    }
    fse.removeSync(dataPath)
  }

  const hasCurrentProfile = fse.existsSync(currentProfilePath)
  const hasLegacyProfile = !hasCurrentProfile && fse.existsSync(legacyProfilePath)
  if (!hasCurrentProfile && !hasLegacyProfile) {
    fse.ensureDirSync(dataPath)
    return { path: dataPath, outcome: "fresh", copied: [], cleanedStaleMigration }
  }

  const copied: string[] = []
  try {
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

    fse.moveSync(temporaryPath, dataPath)
  } catch (error) {
    fse.removeSync(temporaryPath)
    throw new Error(`Could not copy the existing profile to the portable data folder: ${String(error)}`)
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
  const stale = setup.cleanedStaleMigration ? " Discarded an unfinished migration from an earlier run." : ""

  switch (setup.outcome) {
    case "use-existing":
      return `Using the existing RiftLauncher user data folder.${stale}`
    case "migrate":
      return `Copied ${setup.copied.length > 0 ? setup.copied.join(", ") : "nothing"} from the VS Launcher user data folder, which was left untouched.${stale}`
    case "portable-profile-migrated":
      return `Copied the existing RiftLauncher profile to the portable data folder; the original was left untouched.${stale}`
    case "migration-failed":
      return `Could not copy the VS Launcher user data folder${setup.failureReason ? ` (${setup.failureReason})` : ""}. Starting on an empty RiftLauncher folder.${stale}`
    case "fresh":
      return `Created a new RiftLauncher user data folder.${stale}`
    case "unavailable":
      return `No RiftLauncher user data folder was prepared.${stale}`
  }
}
