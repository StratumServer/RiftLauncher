import { ipcMain } from "electron"
import fse from "fs-extra"
import { isUtf8 } from "node:buffer"
import { createHash } from "node:crypto"
import { dirname, join, relative } from "node:path"
import { IPC_CHANNELS } from "../ipcChannels"
import { getConfig } from "@src/config/configManager"
import { ATOMIC_WRITE_TEMP_SUFFIX_MAX, writeTextAtomic } from "@src/ipc/atomicJsonFile"
import { isInstallationPlaying, tryAcquireInstallationOperation } from "@src/ipc/installationActivity"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertConfiguredInstallationPath, assertManagedPath } from "@src/ipc/pathPolicy"
import { assertBoundedString, assertSafeFileName, assertString, comparablePath, isRecord } from "@src/ipc/validation"
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
 * The legacy MAX_PATH limit (260 characters) on Windows.
 *
 * Even though modern Node and .NET runtimes can namespace paths with the `\\?\` prefix or handle
 * longer paths when LongPathsEnabled is enabled, this limit is kept as a cautious compatibility
 * guard for external scripts, tools, and legacy tooling that interact with installation folders
 * without extended-path awareness. Past this length, a pack entry is refused proactively with a
 * named error instead of risking unhandled IO failures down the line. `write-file-atomic` also
 * constructs its temporary filename beside the target, so a path is only writable here if
 * `ATOMIC_WRITE_TEMP_SUFFIX_MAX` still fits within the bound.
 */
const WINDOWS_LEGACY_MAX_PATH = 260

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

/**
 * Bidirectional controls and invisible zero-width format characters.
 *
 * Windows and Unix file systems admit these, but they alter visual rendering: bidi controls (such
 * as U+202E right-to-left override) change the display order of following characters so an extension
 * or stem displays as something else, while zero-width characters (such as U+200B zero-width space)
 * make distinct names look identical or render as empty.
 */
const BIDI_OR_ZERO_WIDTH_CHARACTER = /[\p{Bidi_Control}\p{Cf}\u180E]/u

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
 * the end. Bidi controls and invisible zero-width characters are refused too, so a pack cannot
 * display a different name to the player than the file on disk.
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

    if (WINDOWS_FORBIDDEN_CHARACTER.test(segment) || BIDI_OR_ZERO_WIDTH_CHARACTER.test(segment)) {
      throw new TypeError("Invalid mod config key")
    }
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

  // A config file is content, not an identifier, and the export side already wrote whatever the
  // player had on disk. Two things follow from that, and both are load-bearing: an empty file is
  // a real file, and no file in a pack can be bigger than the pack. Bounding the text by
  // `MAX_IPC_STRING_LENGTH` instead would refuse the other half of every export the launcher
  // itself produces — and because one bad value costs the whole settings block, a single
  // 9 KB file would take every other config in the pack down with it.
  return { sha256, text: assertBoundedString(value.text, "mod config text", MAX_MODPACK_BYTES) }
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

/**
 * Parses the config names a player ticked in the export picker.
 *
 * An empty list means the player unticked everything, which produces a pack with no settings block
 * at all. When configs are included, the export caller requires an explicit list of chosen names;
 * an absent list (`undefined` or `null`) returns `undefined`, which the export handler refuses as
 * an unprompted sweep.
 *
 * Nothing here validates a name as a path, and nothing needs to: these names are matched against the
 * keys `walkModConfigs` produced, so a name that matches nothing is dropped and no name can reach a
 * file the walk did not find. A shape that is not a list of strings is a malformed request rather
 * than a refusal, because nothing about the folder or the pack can produce one.
 *
 * @param value The request's config names.
 * @throws {TypeError} When the value is neither absent nor a list of strings.
 */
export function parseChosenConfigNames(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new TypeError("Invalid modpack export request")
  for (const name of value) {
    if (typeof name !== "string") throw new TypeError("Invalid modpack export request")
  }

  return value as readonly string[]
}

/** One file found under an installation's `ModConfig` folder, with its bytes when they were read. */
type CollectedConfig = ModConfigListingEntry & { raw: Buffer | undefined }
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
export type ExportModpackConfigFailure = Exclude<ExportModpackRefusal, "too-large">

/**
 * Walks an installation's `ModConfig` folder.
 *
 * The folder is reached through `assertManagedPath`, so it is inside a managed installation and has
 * no symbolic link in any of its existing ancestors, and every file is read with `lstat` so a link
 * *inside* the folder is set aside rather than followed out of it. A `.json` extension is what makes
 * a file a candidate at all, compared without case because Windows does not.
 *
 * A link is not a file, but it is not nothing either: the apply refuses a config at its name and
 * below it, so the walk reports it by name for the import dialog to say so. That is all it does with
 * one. It is neither opened nor followed, which is why the folder a link points at is never listed.
 *
 * @param installationPath An installation folder, already asserted as a configured one.
 * @param options.readText Read each file's bytes. Off for the import dialog, which shows names and
 *   sizes and has no use for the contents.
 * @param options.only The keys to look at, or undefined for all of them. Filtered before the read,
 *   so a pack the player narrowed down does not read the files they left out of it. It narrows the
 *   files and never the links, which are a fact about the folder and not a choice of the player's.
 * @returns The files and the links, each relative to the folder with `/` between directories.
 * @throws When the folder cannot be listed, or a file cannot be read.
 */
async function walkModConfigs(installationPath: string, options: { readText: boolean; only?: ReadonlySet<string> }): Promise<{ files: CollectedConfig[]; linked: string[] }> {
  const root = join(installationPath, MOD_CONFIG_FOLDER_NAME)
  if (!(await fse.pathExists(root))) return { files: [], linked: [] }

  const safeRoot = await assertManagedPath(root, "mod config folder")
  const rootStats = await fse.lstat(safeRoot)
  // A file where the folder belongs: `ensureDir` would fail on it later with an ENOTDIR that names
  // nothing, so it is refused here while there is still a reason to give.
  if (!rootStats.isDirectory()) throw new Error("The ModConfig folder is not a folder")

  const found: CollectedConfig[] = []
  const linked: string[] = []
  // The one shape a name leaves this walk in, for a file and for a link: relative, `/` between directories.
  const keyOf = (path: string): string => relative(safeRoot, path).replaceAll("\\", "/")

  const visit = async (folder: string): Promise<void> => {
    const entries = await fse.readdir(folder, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = join(folder, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      // `isDirectory()` and `isFile()` are both false for a link, and that is the answer we want:
      // reading through one would let a link in the folder hand the launcher a file from anywhere on
      // the disk, and descending into one would list a folder from anywhere on it. It is named and
      // nothing more, and whatever it is called: a folder that is a link has no reason to end in
      // `.json`, and the pack's names that sit under it are refused all the same.
      if (entry.isSymbolicLink()) {
        linked.push(keyOf(entryPath))
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue

      const stats = await fse.lstat(entryPath)
      // No key rule here. This walk answers "what is in the folder", and a folder can hold a name
      // that is legal on the file system it was created on and unusable in a pack; the caller that
      // builds a pack is the one that has to say so, because only it can name the file.
      const key = keyOf(entryPath)
      // Before the read and before the ceiling, so a narrowed pack neither reads nor counts what it
      // left out. The keys are the walk's own, which is why the caller can pass the player's
      // selection through without validating it as a path: a name that matches nothing matches
      // nothing, and no name can reach a file this walk did not find.
      if (options.only && !options.only.has(key)) continue
      // RangeError, and not Error, so the pack builder below can tell "the folder is too big to
      // carry" from "the folder could not be read" without matching on a sentence.
      if (found.length >= MAX_MODPACK_ENTRIES) throw new RangeError("Too many mod configs")

      // Read as bytes and never as text. The export has to know whether the bytes are UTF-8 before
      // it decodes anything, and it has to digest the bytes it read rather than text that came back
      // out of a decoder; `readFile(path, "utf-8")` is the call that made both impossible.
      found.push({ name: key, bytes: stats.size, raw: options.readText ? await fse.readFile(entryPath) : undefined })
    }
  }

  await visit(safeRoot)
  return { files: found, linked }
}

/**
 * Builds a pack's `settings` from an installation's own configs.
 *
 * Every file is checked for one thing: that its bytes can travel in a pack as the bytes they are.
 * They cannot when the file is not UTF-8, and `readFile(path, "utf-8")` hides that: an invalid byte
 * becomes the replacement character instead of failing, so a pack built from the decoded text would
 * carry bytes that are not the file's. They also cannot when the file holds a NUL, because the
 * importer's own string guard refuses one and a pack's settings block is dropped whole on a single
 * bad value, which would cost the pack every config it carries. Refusing at export names the file
 * and leaves the pack's mods alone, the same trade every other tolerant path in this file makes.
 *
 * @param installationPath An installation folder, already asserted as a configured one.
 * @param chosenNames The keys the player ticked in the export picker, or undefined for all of them.
 *   An empty list is a real answer: the player unticked everything, so the pack carries no settings.
 * @returns The settings block, or the file and reason the pack cannot carry it.
 */
export async function collectModConfigs(
  installationPath: string,
  chosenNames?: readonly string[]
): Promise<{ ok: true; settings: Record<string, ModConfigEntry> } | { ok: false; reason: ExportModpackConfigFailure; name?: string }> {
  let files: CollectedConfig[]
  try {
    files = (await walkModConfigs(installationPath, { readText: true, only: chosenNames ? new Set(chosenNames) : undefined })).files
  } catch (err) {
    if (err instanceof RangeError) {
      logMessage("error", `${LOG_PREFIX} [EXPORT_MODPACK] The ModConfig folder holds more files than a modpack may carry.`)
      return { ok: false, reason: "too-many" }
    }
    logMessage("error", `${LOG_PREFIX} [EXPORT_MODPACK] Could not read the ModConfig folder.`)
    logMessage("debug", `${LOG_PREFIX} [EXPORT_MODPACK] ${getErrorMessage(err)}`)
    return { ok: false, reason: "unreadable-config" }
  }

  const settings: Record<string, ModConfigEntry> = {}
  // The two ends of a pack have to agree about which keys exist, or the export writes a pack the
  // import drops whole. Both rules below are the import's rules, run here so that the file to
  // complain about is known while the pack is being built rather than on somebody else's machine.
  // A name Windows would refuse is legal on the file system it was created on, so refusing the
  // export is the only way to name it: the player can rename one file, and cannot rename a folder.
  const folded = new Set<string>()
  for (const file of files) {
    try {
      assertModConfigKey(file.name)
    } catch (err) {
      logMessage("debug", `${LOG_PREFIX} [EXPORT_MODPACK] ${getErrorMessage(err)}`)
      return { ok: false, reason: "bad-name", name: file.name }
    }
    const lower = file.name.toLowerCase()
    if (folded.has(lower)) return { ok: false, reason: "collides", name: file.name }
    folded.add(lower)

    // `isUtf8` and not a length comparison. A byte sequence cut short decodes to one U+FFFD and
    // re-encodes to three bytes, so a file whose last character was truncated passed a
    // `Buffer.byteLength(text, "utf8") !== bytes` test and travelled as `EF BF BD` under a digest
    // computed over the altered text. A NUL is refused in the same breath because the importer's own
    // string guard refuses one, and a single such file would take the pack's whole settings block
    // down with it on the other side.
    const raw = file.raw
    if (!raw || !isUtf8(raw) || raw.includes(0)) return { ok: false, reason: "not-utf8", name: file.name }
    // The digest is over the bytes that were read, which are the bytes the file holds and the bytes
    // the import compares against. Nothing is re-encoded anywhere in this path.
    settings[file.name] = { sha256: digestOf(raw), text: raw.toString("utf8") }
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
 * Reads an installation's `ModConfig` folder for the import dialog and the export checkbox.
 *
 * It refuses while the game is running and refuses nothing else. It used to take the exclusive
 * operation lease, which made two reads in flight one refusal: Manage Mods mounts the action bar and
 * the import dialog together, both ask for this listing, and the dialog was told `busy` on every page
 * load, so it opened on "the folder could not be read" with no rows and a disabled button. A read
 * does not need to exclude a read, and it does need to stay out of a folder the game is writing,
 * which is the one thing `playing` says.
 *
 * Besides the files it names the links in the folder, for the import dialog alone. A name a link
 * sits at is not a name this Installation "has no file at", and the dialog has to be able to tell
 * the two apart before the apply refuses it.
 */
ipcMain.handle(IPC_CHANNELS.MODS_MANAGER.GET_MOD_CONFIGS, async (event, installationPath: unknown): Promise<ModConfigsReadResult> => {
  assertTrustedIpcSender(event)
  const installation = await assertConfiguredInstallationPath(installationPath)

  try {
    const { record } = await installationRecordAt(installation)
    if (isInstallationPlaying(record.id)) {
      logMessage("info", `${LOG_PREFIX} [GET_MOD_CONFIGS] Refused: playing.`)
      return { ok: false, reason: "playing" }
    }

    const { files, linked } = await walkModConfigs(installation, { readText: false })
    return { ok: true, configs: files.map(({ name, bytes }) => ({ name, bytes })), linked }
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

type ConfigDestinationResolution = { ok: true; destination: string } | { ok: false; reason: "ambiguous" | "not-directory" }
type ModConfigDirectoryEntry = { name: string; isDirectory(): boolean }
type ModConfigDirectoryIndex = Map<string, ModConfigDirectoryEntry[]>

/**
 * Finds the spelling already on disk for a config path.
 *
 * Packs can move between case-sensitive and case-insensitive filesystems. When the requested
 * spelling is absent, use a unique case-folded match at each path component so an import replaces
 * the player's existing file instead of creating a second file beside it. If the disk already has
 * multiple case variants and none exactly matches the pack, refuse the entry rather than choosing
 * one arbitrarily.
 */
async function resolveConfigDestination(root: string, key: string, directories: Map<string, ModConfigDirectoryIndex>): Promise<ConfigDestinationResolution> {
  const segments = key.split("/")
  let current = root

  for (const [index, segment] of segments.entries()) {
    const folder = await fse.lstat(current).catch(() => undefined)
    if (!folder) return { ok: true, destination: join(current, ...segments.slice(index)) }
    if (folder.isSymbolicLink() || !folder.isDirectory()) return { ok: false, reason: "not-directory" }

    let indexByName = directories.get(current)
    if (!indexByName) {
      // Re-check the real spelling before listing it. The case-folded path the pack asked for may
      // have been absent, so validating only that spelling would miss a linked existing directory.
      await assertManagedPath(current, "mod config folder")
      indexByName = new Map<string, ModConfigDirectoryEntry[]>()
      for (const entry of await fse.readdir(current, { withFileTypes: true })) {
        const foldedName = entry.name.toLowerCase()
        const matches = indexByName.get(foldedName) ?? []
        matches.push(entry)
        indexByName.set(foldedName, matches)
      }
      directories.set(current, indexByName)
    }

    const matches = indexByName.get(segment.toLowerCase()) ?? []
    if (matches.length === 0) return { ok: true, destination: join(current, ...segments.slice(index)) }

    const exact = matches.find((entry) => entry.name === segment)
    if (matches.length > 1 && !exact) return { ok: false, reason: "ambiguous" }
    const selected = exact ?? matches[0]!
    if (index < segments.length - 1 && !selected.isDirectory()) return { ok: false, reason: "not-directory" }
    current = join(current, selected.name)
  }

  return { ok: true, destination: current }
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
  const folded = new Set<string>()

  return files.map((entry) => {
    if (!isRecord(entry)) throw new TypeError("Invalid mod config request")

    const key = assertModConfigKey(entry.name)
    // The same fold the pack parser applies, on the same reasoning: two keys differing only in case
    // are one file on Windows, and only the first of them would be copied aside, so the second
    // write would land on a file with no way back.
    const lower = key.toLowerCase()
    if (folded.has(lower)) throw new TypeError("Invalid mod config request")
    folded.add(lower)

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
  // The id is in the folder name, not only a fallback for a missing one, and that is the one place
  // this departs from the installation archive's own naming (src/domain/installations/backup.ts,
  // `cleanFolderName(name) || id.slice(0, 8)`). An archive is one file per run that nothing else
  // writes, so a shared folder costs it nothing. These folders are pruned, and each apply prunes to
  // its OWN installation's limit: two installations that happen to share a name would otherwise
  // delete each other's only way back, silently, during an apply the other one never asked for.
  const folder = `${cleanFolderName(record.name) || "installation"}-${record.id.slice(0, 8)}`
  const parent = await assertManagedPath(join(backupsFolder, SETTINGS_BACKUP_SUBFOLDER, folder), "settings backup folder", {
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
 *
 * `keep` is this run's own folder, and it is never a candidate. It is the folder the apply has just
 * filled and the one the answer names, so removing it would leave the player with a message pointing
 * at a folder that is not there and no copy of anything that was replaced. Sorting by mtime alone
 * does not protect it: a folder whose mtime is in the future, from a clock that stepped back or from
 * an archive restored with a later date, sorts ahead of it and pushes it past the limit.
 */
async function pruneRecoveryFolders(parent: string, limit: number, keep: string): Promise<void> {
  const folders: { path: string; mtimeMs: number }[] = []

  for (const entry of await fse.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(SETTINGS_BACKUP_PREFIX)) continue
    const path = join(parent, entry.name)
    const stats = await fse.lstat(path).catch(() => undefined)
    if (stats?.isDirectory()) folders.push({ path, mtimeMs: stats.mtimeMs })
  }

  folders.sort((left, right) => right.mtimeMs - left.mtimeMs)
  // This run's folder counts against the limit like any other, so the newest `max(1, limit) - 1`
  // of the rest are the ones that stay.
  const candidates = folders.filter((folder) => folder.path !== keep)
  for (const stale of candidates.slice(Math.max(1, limit) - 1)) await fse.remove(stale.path)
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
 *  8. the writes happen, one file at a time, each naming its own failure;
 *  9. a record of what landed is written into the recovery folder if existing files were
 *     displaced, so a run that was killed part way through still says which half it got through;
 *  10. the recovery folders past the limit are pruned, non-fatally, and only by a run that
 *     displaced something: a run that wrote nothing has no newest folder to keep, and one that
 *     removed the folder it created has nothing left to name.
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
    const configDirectories = new Map<string, ModConfigDirectoryIndex>()

    // Before anything is read, copied or created: every destination folder has to be a folder inside
    // the Installation with no symbolic link in its existing ancestors. Without this pass the checks
    // below came too late to matter. A folder in `ModConfig` that is a link sent the `lstat`, the
    // `readFile` and the `copy` outside the Installation, so a copy of a stranger's file landed in
    // the recovery folder, and the `ensureDir` in the write loop created folders out there; only then
    // was `assertManagedPath` asked, and by then the file it was meant to protect had already been
    // read. The path length is checked here too, so a pack that would land past what Windows takes
    // is refused before a single copy is made.
    for (const entry of pending) {
      try {
        const resolution = await resolveConfigDestination(modConfigRoot, entry.key, configDirectories)
        if (!resolution.ok) {
          logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${resolution.reason}`)
          failed.push({ name: entry.key, reason: "write-failed" })
          refused.add(entry.key)
          continue
        }
        entry.destination = resolution.destination

        // The call is the check: it walks the components that exist and refuses a path that leaves
        // the Installation. What it resolves is not read, and a log line may not name it either.
        await assertManagedPath(dirname(entry.destination), "mod config folder", { allowMissing: true })
        // The whole path Windows has to take, not the folder holding it: a 245 character file name
        // under a 46 character folder is 292 characters in all, and it is the write that fails.
        // The temp name the write opens first is charged to the destination, so a destination that
        // fits and a temp name that does not is the same failure, one step later and less clear.
        if (entry.destination.length + ATOMIC_WRITE_TEMP_SUFFIX_MAX > WINDOWS_LEGACY_MAX_PATH) {
          logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] The path is longer than Windows takes`)
          throw new Error("Path is too long")
        }
      } catch (err) {
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${getErrorMessage(err)}`)
        failed.push({ name: entry.key, reason: "write-failed" })
        refused.add(entry.key)
      }
    }

    // Step 7's first half: decide, per file, whether anything is going to be displaced at all.
    const applyOneConfigEntry = async (entry: PendingConfig): Promise<void> => {
      // Already refused above, and skipped rather than re-examined: the `lstat`, the `readFile` and
      // the `copy` below are the three calls that must not run on a path the pre-pass rejected. A
      // key refused there is one whose destination is behind a link, so reading it reads somebody
      // else's file and copying it puts a copy of that file in the recovery folder.
      if (refused.has(entry.key)) return

      // The digest is a claim about the text right next to it, and the only thing that can check it
      // is the text. A record that fails here was edited by hand after the pack was made, or was
      // written by something that never digested anything; either way the file is not what the pack
      // says it is, and writing it would be writing a lie the player cannot see.
      if (digestOf(Buffer.from(entry.text, "utf8")) !== entry.sha256) {
        failed.push({ name: entry.key, reason: "digest-mismatch" })
        refused.add(entry.key)
        return
      }

      const existing = await fse.lstat(entry.destination).catch(() => undefined)
      if (!existing) {
        kinds.set(entry.key, "new")
        return
      }
      // A link or a directory where a config belongs. The same `lstat` the icon copy does before it
      // writes, and for the same reason: `fse.copy` copies a link rather than what it points at, so a
      // backup taken without this check is a link to the very file being replaced.
      if (existing.isSymbolicLink() || !existing.isFile()) {
        failed.push({ name: entry.key, reason: "write-failed" })
        refused.add(entry.key)
        return
      }

      const current = await fse.readFile(entry.destination)
      if (digestOf(current) === entry.sha256) {
        skipped.push(entry.key)
        refused.add(entry.key)
        return
      }

      kinds.set(entry.key, "replace")
      const backupPath = join(await recoveryFolderFor(), relative(modConfigRoot, entry.destination))
      // The recovery copy is the first thing opened for a file that already exists, and it is not
      // opened under the destination: it carries the backups root, the Installation's backup folder
      // and the recovery folder itself, so it is usually the longer of the two. Measured here rather
      // than in the pre-pass because the recovery folder is only made for a file that is really
      // being displaced, and making it earlier to measure it would be making it for nothing.
      if (backupPath.length + ATOMIC_WRITE_TEMP_SUFFIX_MAX > WINDOWS_LEGACY_MAX_PATH) {
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] The backup path is longer than Windows takes`)
        failed.push({ name: entry.key, reason: "write-failed" })
        refused.add(entry.key)
        return
      }
      await fse.ensureDir(dirname(backupPath))
      try {
        // The option pair `preserveUnreadableStore` uses (src/ipc/accountStore.ts): overwrite is
        // off, so an existing destination is left as it is instead of being clobbered.
        await fse.copy(entry.destination, backupPath, { overwrite: false, errorOnExist: false })
        // The digest, not the length: a copy that is the right size and the wrong bytes is exactly
        // the failure a recovery folder must not contain, and the digest of what was read is
        // already in hand. `lstat` first because a link is not a copy of anything.
        const copied = await fse.lstat(backupPath)
        if (!copied.isFile() || digestOf(await fse.readFile(backupPath)) !== digestOf(current)) {
          await fse.remove(backupPath)
          failed.push({ name: entry.key, reason: "not-landed" })
          refused.add(entry.key)
          return
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

    // Every file answers for itself. A config whose folder cannot be read, or whose recovery
    // folder cannot be made, is a failure of that file alone: without this the whole invoke
    // rejects, and a pack of fifty configs loses all fifty because one of them sits in a
    // directory the player no longer has permission on.
    for (const entry of pending) {
      try {
        await applyOneConfigEntry(entry)
      } catch (err) {
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${getErrorMessage(err)}`)
        failed.push({ name: entry.key, reason: "write-failed" })
        refused.add(entry.key)
      }
    }

    const appliedRecords: string[] = []
    for (const entry of pending) {
      if (refused.has(entry.key)) continue

      try {
        await fse.ensureDir(dirname(entry.destination))
        // Asked again after the `ensureDir` above, which may have created the folder the pre-pass
        // only validated as absent. `assertManagedPath` walks the components that exist, so this is
        // the check on what the apply itself just made.
        await assertManagedPath(dirname(entry.destination), "mod config folder", { allowMissing: true })
        await writeTextAtomic(entry.destination, entry.text)
        applied.push({ name: entry.key, kind: kinds.get(entry.key) ?? "new" })
        appliedRecords.push(relative(modConfigRoot, entry.destination).replaceAll("\\", "/"))
      } catch (err) {
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${getErrorMessage(err)}`)
        failed.push({ name: entry.key, reason: "write-failed" })
      }
    }

    const hasReplaced = applied.some((entry) => entry.kind === "replace")

    // The backup limit is spent by what a run actually displaced, so the prune waits until the write
    // loop is done and only runs when something was actually replaced. An apply that wrote nothing,
    // or wrote only new files without displacing existing ones, does not cost the player the
    // recovery folder that would have taken them back to prior state.
    if (hasReplaced && recoveryFolder) {
      const landed = appliedRecords.join("\n")
      await writeTextAtomic(join(recoveryFolder, APPLIED_RECORD_NAME), `${landed}\n`).catch((err: unknown) => {
        logMessage("error", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] Could not write the applied record.`)
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${getErrorMessage(err)}`)
      })
      try {
        await pruneRecoveryFolders(dirname(recoveryFolder), record.backupsLimit, recoveryFolder)
      } catch (err) {
        // Non-fatal: the backups this run needed are already written. A prune that cannot finish is
        // about old folders piling up, which is the next backup's problem and the log's business.
        logMessage("error", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] Could not prune old settings backups.`)
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] ${getErrorMessage(err)}`)
      }
    } else if (recoveryFolder) {
      // A recovery folder with nothing displaced reads as a way back when there is nothing to go
      // back to (or only holds files from write failures that were never replaced), so it is dropped
      // rather than left to the next run's prune. The result must not name it either.
      await fse.remove(recoveryFolder).catch((err: unknown) => {
        logMessage("debug", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] Could not remove the unneeded recovery folder. ${getErrorMessage(err)}`)
      })
      recoveryFolder = null
    }

    logMessage("info", `${LOG_PREFIX} [APPLY_MOD_CONFIGS] Wrote ${applied.length} configs, skipped ${skipped.length}, failed ${failed.length}.`)
    return { ok: true, backupFolder: recoveryFolder ?? "", applied, skipped, failed }
  } finally {
    lease.release()
  }
})
