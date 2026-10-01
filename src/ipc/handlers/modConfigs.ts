import { ipcMain } from "electron"
import fse from "fs-extra"
import { createHash } from "node:crypto"
import { dirname, join, relative } from "node:path"
import { IPC_CHANNELS } from "../ipcChannels"
import { getConfig } from "@src/config/configManager"
import { writeTextAtomic } from "@src/ipc/atomicJsonFile"
import { tryAcquireInstallationOperation } from "@src/ipc/installationActivity"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertConfiguredInstallationPath, assertManagedPath } from "@src/ipc/pathPolicy"
import { assertSafeFileName, assertString, comparablePath, isRecord } from "@src/ipc/validation"
import { getErrorMessage, logMessage } from "@src/utils/logManager"
import { describeBackupSpaceShortfall } from "@domain/installations/backupCapacity"
import { MOD_CONFIG_FOLDER_NAME } from "@domain/mods/folder"
import { cleanFolderName, formatTimestampForFilename } from "@domain/naming"

const LOG_PREFIX = "[back] [mods] [ipc/handlers/modConfigs.ts]"

/**
 * How many rows a pack may carry, whatever they are rows of.
 *
 * It is the bound on mods, on servers and on settings together, because it exists to keep the dialog
 * a person is asked to read from growing without end, not to police any one field.
 */
export const MAX_MODPACK_ENTRIES = 2_000

/**
 * The ceiling on one modpack file, and the reason it is not the 2 MiB it used to be: since #363 a
 * pack can carry a `ModConfig` folder, and a folder of hand-tuned JSON is measured in kilobytes while
 * two thousand of them are measured in megabytes. Refusing the file is still better than holding it
 * in memory, and the importer applies the same number so the two ends cannot disagree about which
 * packs exist.
 */
export const MAX_MODPACK_BYTES = 8 * 1024 * 1024

/** The longest whole key a pack may use. Each of its segments is held to assertSafeFileName's 255. */
const MAX_MOD_CONFIG_KEY_LENGTH = 512

/**
 * Names Windows refuses to create a file under, with or without an extension: the DOS device names
 * that predate NTFS and still work, and the numbered variants of the two port families. `¹` is not a
 * digit to Windows either, which is why it is spelled out rather than written as a range.
 */
const WINDOWS_RESERVED_BASE_NAME = /^(con|prn|aux|nul|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * Characters no Windows file name may hold, and the control characters no file system should.
 *
 * The control-character half is the point of the rule, so the lint that objects to a control range
 * inside a character class is the rule being wrong here.
 */
// eslint-disable-next-line no-control-regex
const WINDOWS_FORBIDDEN_CHARACTER = /[?*<>|":\u0000-\u001f\u007f]/

/** How many times a recovery folder name may be bumped before the apply gives up. */
const MAX_RECOVERY_FOLDER_ATTEMPTS = 32

/** The subfolder of the backups root that holds one folder per installation. */
const SETTINGS_BACKUP_SUBFOLDER = "Settings"

/** The prefix of every folder this file creates under an installation's backup folder. */
const SETTINGS_BACKUP_PREFIX = "settings_"

/** The record an apply leaves in its recovery folder, so a half-finished run is still readable. */
const APPLIED_RECORD_NAME = "applied.txt"

/**
 * A pack key has to be a relative path of `.json` names below `ModConfig`, written the way every
 * other archive in this launcher writes one: forward slashes, because a pack is read on every
 * platform and `path.sep` would bake in the platform that exported it. The repo already has this
 * rule written down for archive entries (src/ipc/validation.ts), and a key that came from somewhere
 * else is exactly as untrusted as an archive entry.
 *
 * Every segment is held to what `assertSafeFileName` already allows, and the rest is what Windows
 * adds on top of that: a device name, a character it will not put in a name, a space or a dot at
 * the end. Those are refused here rather than discovered on a Windows machine by everybody else.
 *
 * @param value Key as a pack or a dialog sent it.
 * @returns The key, unchanged, once every rule has passed.
 * @throws TypeError, naming the rule that refused it.
 */
export function assertModConfigKey(value: unknown): string {
  const key = assertString(value, "mod config key", MAX_MOD_CONFIG_KEY_LENGTH)
  const segments = key.split("/")

  // Only the last segment is the file. The ones before it are folders, made by the game and by
  // players, and `ConfigureEverything/Client/RoomSize.json` is what a real ModConfig folder looks
  // like: holding the ones before it to the .json rule would refuse every nested config there is.
  const fileName = segments.at(-1) ?? ""
  if (!fileName.toLowerCase().endsWith(".json")) throw new TypeError("Mod config keys must name a .json file")
  // Everything ahead of the extension is the part Windows looks at when it decides whether a name is
  // a device, or is a name that differs from another in a way no file manager will show.
  const stem = fileName.slice(0, -".json".length)

  for (const segment of segments) {
    // Covers the empty segment a leading, doubled or trailing slash produces, "." and "..", the
    // backslash a pack written on Windows may carry, and anything over 255 characters.
    assertSafeFileName(segment, "mod config key")

    if (WINDOWS_FORBIDDEN_CHARACTER.test(segment)) throw new TypeError("Invalid mod config key")
    // A device name and a trailing dot or space are not visible in a file manager, so two keys that
    // differ only by one are one file on Windows and the second write is the only one to land. The
    // regex's own optional extension is what lets a folder called Client past and a folder called
    // nul not, which is the same line Windows draws.
    const tail = segment === fileName ? stem : segment
    if (WINDOWS_RESERVED_BASE_NAME.test(segment) || /[. ]$/.test(tail)) throw new TypeError("Invalid mod config key")
  }

  return key
}

/**
 * Checks one settings entry's shape and returns it rebuilt from named fields.
 *
 * The digest is checked for shape here and for truth at the apply, one file at a time. Comparing it
 * while parsing would be the wrong place: a pack whose one entry was edited by hand would lose its
 * whole settings block, and the config it carries is the part its author did not get wrong.
 *
 * @throws TypeError when the entry is not a record of a string and a digest.
 */
function parseModConfigEntry(value: unknown): ModConfigEntry {
  if (!isRecord(value)) throw new TypeError("Invalid mod config entry")

  const sha256 = assertString(value.sha256, "mod config digest", 64)
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError("Invalid mod config digest")

  return { sha256, text: assertString(value.text, "mod config text") }
}

/**
 * Parses a pack's whole `settings` block, or says why it cannot be used.
 *
 * Tolerant the way `normalizeServerBookmarks` is: one bad key costs the whole settings block and
 * nothing else, because a pack whose settings do not load is still a good pack of mods. That is also
 * why a `settings` field of the wrong type is a refusal rather than a throw — without the
 * `isRecord` guard below, `null` would throw out of `Object.keys` and take the mods down with it.
 *
 * @param value The `settings` field, or `undefined` when the pack has none.
 * @returns The parsed block, or the reason it was dropped with the key that did it.
 */
export function parseModpackSettings(value: unknown): { ok: true; settings: Record<string, ModConfigEntry> } | { ok: false; refused: SettingsRefused } {
  if (value === undefined) return { ok: true, settings: {} }
  if (!isRecord(value)) return { ok: false, refused: { reason: "bad-value" } }

  const keys = Object.keys(value)
  if (keys.length > MAX_MODPACK_ENTRIES) return { ok: false, refused: { reason: "too-many" } }

  // Two keys that differ only in case are one file on NTFS and on APFS, so whichever is written
  // second would be the only one on disk. Refusing the block is the answer that does not depend on
  // which platform the reader is on.
  const folded = new Set<string>()

  const settings: Record<string, ModConfigEntry> = {}
  for (const key of keys) {
    try {
      assertModConfigKey(key)
    } catch {
      return { ok: false, refused: { reason: "bad-key", name: key } }
    }

    const caseFolded = key.toLowerCase()
    if (folded.has(caseFolded)) return { ok: false, refused: { reason: "bad-key", name: key } }
    folded.add(caseFolded)

    try {
      settings[key] = parseModConfigEntry(value[key])
    } catch {
      return { ok: false, refused: { reason: "bad-value", name: key } }
    }
  }

  return { ok: true, settings }
}

/** One file found under an installation's `ModConfig` folder. */
type CollectedConfig = ModConfigListingEntry & { text: string }
/**
 * The digest of exactly the bytes a file holds, which is also the digest a pack's entry claims.
 *
 * @param bytes The file's own bytes, never text that came back from disk and was re-encoded.
 */
function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * What export refuses to put in a pack, and the two that are the pack's own fault rather than the
 * player's. `not-utf8` is a file the launcher cannot carry without lying about it: see
 * {@link collectModConfigs}.
 */
export type ExportModpackConfigFailure = "unreadable-config" | "not-utf8" | "too-many"

/**
 * Walks an installation's `ModConfig` folder.
 *
 * The folder is reached through `assertManagedPath`, so it is inside a managed installation and has
 * no symbolic link in any of its existing ancestors, and every file is read with `lstat` so a link
 * *inside* the folder is skipped rather than followed out of it. A `.json` extension is what makes a
 * file a candidate at all, compared without case because Windows does not.
 *
 * @param installationPath An installation folder, already asserted as a configured one.
 * @param options.readText Read the bytes and decode them. Off for the import dialog, which shows
 *   names and sizes and has no use for the text.
 * @returns The files, relative to the folder with `/` between directories.
 * @throws When the folder cannot be listed, or a file cannot be read.
 */
async function walkModConfigs(installationPath: string, options: { readText: boolean }): Promise<CollectedConfig[]> {
  const root = join(installationPath, MOD_CONFIG_FOLDER_NAME)
  if (!(await fse.pathExists(root))) return []

  const safeRoot = await assertManagedPath(root, "mod config folder")
  const rootStats = await fse.lstat(safeRoot)
  // A file where the folder belongs: `ensureDir` would fail on it later with an ENOTDIR that names
  // nothing, so it is refused here while there is still a reason to give.
  if (!rootStats.isDirectory()) throw new Error("The ModConfig folder is not a folder")

  const found: CollectedConfig[] = []

  const visit = async (folder: string): Promise<void> => {
    const entries = await fse.readdir(folder, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = join(folder, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      // `isFile()` is false for a link, and that is the answer we want: reading through one would
      // let a link in the folder hand the launcher a file from anywhere on the disk.
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue

      const stats = await fse.lstat(entryPath)
      const key = relative(safeRoot, entryPath).replaceAll("\\", "/")
      assertModConfigKey(key)
      if (found.length >= MAX_MODPACK_ENTRIES) throw new Error("Too many mod configs")

      found.push({ name: key, bytes: stats.size, text: options.readText ? await fse.readFile(entryPath, "utf-8") : "" })
    }
  }

  await visit(safeRoot)
  return found
}

/**
 * Builds a pack's `settings` from an installation's own configs.
 *
 * Every file is checked for one thing: that its bytes survive being decoded as UTF-8 and encoded
 * back. They do not, when the file holds a byte sequence that is not valid UTF-8, because
 * `Buffer.from(text, "utf8")` replaces each such byte with the replacement character instead of
 * failing — so a pack built from it would carry text that is not the file, and the import would then
 * refuse it as a digest mismatch. Refusing at export instead names the file and leaves the pack's
 * mods alone, which is the same trade every other tolerant path in this file makes.
 *
 * @param installationPath An installation folder, already asserted as a configured one.
 * @returns The settings block, or the file and reason the pack cannot carry it.
 */
export async function collectModConfigs(installationPath: string): Promise<{ ok: true; settings: Record<string, ModConfigEntry> } | { ok: false; reason: ExportModpackConfigFailure; name?: string }> {
  let files: CollectedConfig[]
  try {
    files = await walkModConfigs(installationPath, { readText: true })
  } catch (err) {
    logMessage("error", `${LOG_PREFIX} [EXPORT_MODPACK] Could not read the ModConfig folder.`)
    logMessage("debug", `${LOG_PREFIX} [EXPORT_MODPACK] ${getErrorMessage(err)}`)
    return { ok: false, reason: "unreadable-config" }
  }

  const settings: Record<string, ModConfigEntry> = {}
  for (const file of files) {
    if (Buffer.byteLength(file.text, "utf8") !== file.bytes) return { ok: false, reason: "not-utf8", name: file.name }
    // The digest is over the re-encoded text rather than over a second read of the file: the check
    // above is what says those are the same bytes, and this way a 2000-file folder is read once.
    settings[file.name] = { sha256: digestOf(Buffer.from(file.text, "utf8")), text: file.text }
  }

  return { ok: true, settings }
}

/**
 * The installation a configured path belongs to, which is the record the recovery folder is named
 * after, and the config it was found in, because the backup folder is a config setting rather than
 * anything the installation carries.
 */
async function installationRecordAt(installationPath: string): Promise<{ record: InstallationType; config: ConfigType }> {
  const config = await getConfig()
  const record = config.installations.find((entry) => comparablePath(entry.path) === comparablePath(installationPath))
  // assertConfiguredInstallationPath already refused every path no installation is configured at, so
  // this cannot be reached. Throwing rather than carrying on is what keeps the type honest.
  if (!record) throw new TypeError("Unknown installation path")

  return { config, record }
}

/**
 * Reads an installation's `ModConfig` folder for the import dialog, under the same lease an apply
 * takes, so a listing can never describe a folder an apply is halfway through rewriting.
 */
ipcMain.handle(IPC_CHANNELS.MODS_MANAGER.GET_MOD_CONFIGS, async (event, installationPath: unknown): Promise<ModConfigsReadResult> => {
  assertTrustedIpcSender(event)
  const installation = await assertConfiguredInstallationPath(installationPath)

  try {
    const { record } = await installationRecordAt(installation)
    const lease = tryAcquireInstallationOperation([record.id])
    if (!lease.ok) {
      logMessage("info", `${LOG_PREFIX} [GET_MOD_CONFIGS] Refused: ${lease.reason}.`)
      return { ok: false, reason: lease.reason }
    }

    try {
      const files = await walkModConfigs(installation, { readText: false })
      return { ok: true, configs: files.map(({ name, bytes }) => ({ name, bytes })) }
    } finally {
      lease.release()
    }
  } catch (err) {
    logMessage("error", `${LOG_PREFIX} [GET_MOD_CONFIGS] Could not list the ModConfig folder.`)
    logMessage("debug", `${LOG_PREFIX} [GET_MOD_CONFIGS] ${getErrorMessage(err)}`)
    return { ok: false, reason: "mod-config-unreadable" }
  }
})

/** One file an apply was asked to write, with everything about it settled before any disk is touched. */
type PendingConfig = {
  key: string
  destination: string
  text: string
  sha256: string
  bytes: number
}

/**
 * Validates an apply request and resolves every key to a destination inside the installation.
 *
 * The keys are re-checked here even though the pack was checked when it was read, because the
 * channel takes its argument from the renderer and the renderer took it from a file: between the two
 * nothing has promised that the string is the same string, or that it is a string at all.
 *
 * @throws TypeError for anything malformed, which rejects the invoke the way every other boundary
 *   in this launcher does. The four values of the refusal union are decisions, not malformed input.
 */
function parseApplyRequest(installationPath: string, files: unknown): PendingConfig[] {
  if (!Array.isArray(files) || files.length > MAX_MODPACK_ENTRIES) throw new TypeError("Invalid mod config request")

  const modConfigRoot = join(installationPath, MOD_CONFIG_FOLDER_NAME)

  return files.map((entry) => {
    if (!isRecord(entry)) throw new TypeError("Invalid mod config request")

    const key = assertModConfigKey(entry.name)
    const { sha256, text } = parseModConfigEntry(entry)
    return { key, destination: join(modConfigRoot, ...key.split("/")), text, sha256, bytes: Buffer.byteLength(text, "utf8") }
  })
}

/**
 * Asks a filesystem how much room is left, and reports nothing when it cannot answer.
 *
 * A mount that does not implement statfs, and a path that is not there yet, are both "no answer"
 * rather than "no space". This is the rule `assertRoomForArchive` (src/ipc/workers/compression.ts)
 * already settled for backups, and this file borrows it rather than deciding it again.
 */
function freeBytesAt(path: string): number | undefined {
  try {
    const stats = fse.statfsSync(path)
    return Number.isFinite(stats.bsize) && stats.bsize > 0 ? stats.bavail * stats.bsize : undefined
  } catch {
    return undefined
  }
}

/**
 * Creates this run's recovery folder and returns it.
 *
 * The stamp has one-second resolution and two exports in the same second are not unusual, so the
 * name is bumped rather than overwriting a folder that is still somebody's way back. `mkdir`
 * without `recursive` is the whole collision test: it fails on an existing folder and succeeds on a
 * new one, which is the question being asked, on every platform.
 */
async function createRecoveryFolder(backupsFolder: string, record: { id: string; name: string }): Promise<string> {
  const parent = await assertManagedPath(join(backupsFolder, SETTINGS_BACKUP_SUBFOLDER, cleanFolderName(record.name) || record.id.slice(0, 8)), "settings backup folder", {
    allowMissing: true
  })
  await fse.ensureDir(parent)

  const stamp = formatTimestampForFilename(Date.now())
  for (let attempt = 1; attempt <= MAX_RECOVERY_FOLDER_ATTEMPTS; attempt++) {
    const candidate = join(parent, `${SETTINGS_BACKUP_PREFIX}${stamp}${attempt === 1 ? "" : `_${attempt}`}`)
    try {
      await fse.mkdir(candidate)
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
  }

  throw new Error("Could not create a settings backup folder")
}

/**
 * Drops the oldest recovery folders past the installation's own limit.
 *
 * By modification time and never by name, because the name is a clock reading a person made by hand
 * and a folder restored from an archive can carry any name at all. The floor of one is the point:
 * `backupsLimit: 0` means "do not keep installation archives", not "keep nothing to put back", and a
 * settings apply that pruned the folder it had just written into would be a joke at the player's
 * expense.
 */
async function pruneRecoveryFolders(parent: string, limit: number): Promise<void> {
  const folders: { path: string; mtimeMs: number }[] = []

  for (const entry of await fse.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(SETTINGS_BACKUP_PREFIX)) continue
    const path = join(parent, entry.name)
    const stats = await fse.lstat(path).catch(() => undefined)
    if (stats?.isDirectory()) folders.push({ path, mtimeMs: stats.mtimeMs })
  }

  folders.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const stale of folders.slice(Math.max(1, limit))) await fse.remove(stale.path)
}

/**
 * Writes a pack's chosen configs into an installation.
 *
 * The order of the steps is the safety of this handler:
 *
 *  1. every key and every entry is checked before a single byte is touched, so a malformed request
 *     cannot leave a half-written folder;
 *  2. the lease is taken, which refuses a second apply and an apply against a game that is running;
 *  3. the backups folder is asked about, because a displaced config with nowhere to be put back is
 *     the one outcome worse than a refused apply;
 *  4. free space is asked about once, covering both the copies and the writes, on both volumes;
 *  5. the `ModConfig` folder is `lstat`ed before anything creates it;
 *  6. the recovery folder is created, exclusively, on the first file that is really displaced;
 *  7. every file the apply will replace is copied into it and the copy is verified, and the
 *     comparison that decides "this is already the pack's own bytes" happens *before* the copies
 *     rather than after: a copy of an unchanged file would leave the newest recovery folder holding
 *     the pack's own bytes, which is exactly the folder a player reaches for when something is
 *     wrong;
 *  8. the recovery folders past the limit are pruned, non-fatally;
 *  9. the writes happen, one file at a time, each naming its own failure;
 *  10. a record of what landed is written last, so a run that was killed part way through still
 *     says which half it got through.
 */
ipcMain.handle(IPC_CHANNELS.MODS_MANAGER.APPLY_MOD_CONFIGS, async (event, installationPath: unknown, files: unknown): Promise<ApplyModConfigsResult> => {
  assertTrustedIpcSender(event)
  const installation = await assertConfiguredInstallationPath(installationPath)
  const pending = parseApplyRequest(installation, files)

  const refuse = (reason: "playing" | "busy" | "no-backups-folder" | "insufficient-space" | "mod-config-unreadable"): ApplyModConfigsResult => {
    logMessage("info", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] Refused: ${reason}.`)
    return { ok: false, reason }
  }

  const { config, record } = await installationRecordAt(installation)
  const lease = tryAcquireInstallationOperation([record.id])
  if (!lease.ok) return refuse(lease.reason)

  try {
    if (pending.length === 0) {
      // Nothing to write is not a refusal. The dialog never gets here: its button is disabled while
      // no row is ticked, and a file that was refused on the way in is not in `pending` either.
      return { ok: true, backupFolder: "", applied: [], skipped: [], failed: [] }
    }

    const backupsFolder = config.backupsFolder
    if (!backupsFolder) return refuse("no-backups-folder")

    const modConfigRoot = join(installation, MOD_CONFIG_FOLDER_NAME)
    const rootStats = await fse.lstat(modConfigRoot).catch(() => undefined)
    if (rootStats && !rootStats.isDirectory()) return refuse("mod-config-unreadable")

    // Twice every file's own bytes: once into the recovery folder, once over the config. The
    // conservative upper bound is deliberate, because counting the files that are actually being
    // replaced means reading them first, and a disk that fills halfway through a set of copies is
    // the outcome this check exists to prevent.
    const requiredBytes = pending.reduce((total, entry) => total + entry.bytes * 2, 0)
    const answers = [freeBytesAt(backupsFolder), freeBytesAt(modConfigRoot)].filter((answer): answer is number => answer !== undefined)
    if (describeBackupSpaceShortfall(requiredBytes, answers.length > 0 ? Math.min(...answers) : undefined)) return refuse("insufficient-space")

    // Made on the first file that is actually being displaced, not before the loop. An apply whose
    // every file is already the pack's own bytes then leaves nothing behind at all, which is the
    // difference between a recovery folder that is empty and no recovery folder: the first reads as
    // a way back when there is nothing to go back to.
    let recoveryFolder: string | null = null
    const recoveryFolderFor = async (): Promise<string> => {
      recoveryFolder ??= await createRecoveryFolder(backupsFolder, record)
      return recoveryFolder
    }

    const applied: { name: string; kind: "new" | "replace" }[] = []
    const skipped: string[] = []
    const failed: { name: string; reason: ApplyFailureReason }[] = []
    const kinds = new Map<string, "new" | "replace">()
    const refused = new Set<string>()

    // Step 7's first half: decide, per file, whether anything is going to be displaced at all.
    for (const entry of pending) {
      // The digest is a claim about the text right next to it, and the only thing that can check it
      // is the text. A record that fails here was edited by hand after the pack was made, or was
      // written by something that never digested anything; either way the file is not what the pack
      // says it is, and writing it would be writing a lie the player cannot see.
      if (digestOf(Buffer.from(entry.text, "utf8")) !== entry.sha256) {
        failed.push({ name: entry.key, reason: "digest-mismatch" })
        refused.add(entry.key)
        continue
      }

      const existing = await fse.lstat(entry.destination).catch(() => undefined)
      if (!existing) {
        kinds.set(entry.key, "new")
        continue
      }
      // A link or a directory where a config belongs. The same `lstat` the icon copy does before it
      // writes, and for the same reason: `fse.copy` copies a link rather than what it points at, so a
      // backup taken without this check is a link to the very file being replaced.
      if (existing.isSymbolicLink() || !existing.isFile()) {
        failed.push({ name: entry.key, reason: "write-failed" })
        refused.add(entry.key)
        continue
      }

      const current = await fse.readFile(entry.destination)
      if (digestOf(current) === entry.sha256) {
        skipped.push(entry.key)
        refused.add(entry.key)
        continue
      }

      kinds.set(entry.key, "replace")
      const backupPath = join(await recoveryFolderFor(), ...entry.key.split("/"))
      await fse.ensureDir(dirname(backupPath))
      try {
        // The option pair `preserveUnreadableStore` uses (src/ipc/accountStore.ts): overwrite is
        // off, so an existing destination is left as it is instead of being clobbered.
        await fse.copy(entry.destination, backupPath, { overwrite: false, errorOnExist: false })
        const copied = await fse.lstat(backupPath)
        if (!copied.isFile() || copied.size !== current.length) {
          await fse.remove(backupPath)
          failed.push({ name: entry.key, reason: "not-landed" })
          refused.add(entry.key)
          continue
        }
      } catch (err) {
        // A copy that threw part way leaves a partial file, and a recovery folder holding a partial
        // file is worse than one holding nothing: it looks like a way back that is not one.
        await fse.remove(backupPath).catch(() => undefined)
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${getErrorMessage(err)}`)
        failed.push({ name: entry.key, reason: "copy-failed" })
        refused.add(entry.key)
      }
    }

    try {
      if (recoveryFolder) await pruneRecoveryFolders(dirname(recoveryFolder), record.backupsLimit)
    } catch (err) {
      // Non-fatal: the backups this run needed are already written. A prune that cannot finish is
      // about old folders piling up, which is the next backup's problem and the log's business.
      logMessage("error", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] Could not prune old settings backups.`)
      logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${getErrorMessage(err)}`)
    }

    for (const entry of pending) {
      if (refused.has(entry.key)) continue

      try {
        await fse.ensureDir(dirname(entry.destination))
        const destinationFolder = await assertManagedPath(dirname(entry.destination), "mod config folder", { allowMissing: true })
        if (destinationFolder.length > 260) {
          // Windows caps a path at MAX_PATH unless it is spelled with the `\\?\` prefix, which this
          // writer does not do. A named refusal beats a half-written file or an ENAMETOOLONG with no
          // explanation in it; the log carries the reason and the dialog carries the file name,
          // which is the split tests/log-provenance.test.ts asks for.
          logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] Refused: path-longer-than-windows-allows.`)
          throw new Error("Path is too long")
        }
        await writeTextAtomic(entry.destination, entry.text)
        applied.push({ name: entry.key, kind: kinds.get(entry.key) ?? "new" })
      } catch (err) {
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${getErrorMessage(err)}`)
        failed.push({ name: entry.key, reason: "write-failed" })
      }
    }

    if (applied.length > 0 && recoveryFolder) {
      const landed = applied.map((entry) => entry.name).join("\n")
      await writeTextAtomic(join(recoveryFolder, APPLIED_RECORD_NAME), `${landed}\n`).catch((err: unknown) => {
        logMessage("error", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] Could not write the applied record.`)
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${getErrorMessage(err)}`)
      })
    }

    logMessage("info", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] Wrote ${applied.length} configs, skipped ${skipped.length}, failed ${failed.length}.`)
    return { ok: true, backupFolder: recoveryFolder ?? "", applied, skipped, failed }
  } finally {
    lease.release()
  }
})
