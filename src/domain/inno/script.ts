/**
 * What an Inno Setup installer's script declares, cut down to what an extraction
 * needs.
 *
 * Both header blocks are read WHOLE, not just as far as the useful fields. The
 * format has no index: every record starts where the previous one ended, so
 * reaching the file table means having crossed the languages, the messages, the
 * types, the components, the tasks and the directories without a single mistake.
 * The payoff is an unexpected check: once everything has been crossed, the first
 * block has to end EXACTLY, to the byte. Bytes left over, or a read that ran
 * long, are the signature of a wrong layout, and the extraction is abandoned
 * before anything has been written.
 *
 * The `[Registry]`, `[Run]` and `[Icons]` sections are crossed and dropped. They
 * are not replayed. That is a choice rather than a gap, and it is the whole
 * point of the exercise: writing nothing outside the version folder is exactly
 * what makes the installer's dialog and its uninstall key disappear.
 */
import { InnoFormatError } from "./errors"
import { InnoRecordReader } from "./records"
import type { InnoSetupVersion } from "./version"
import { hasCloseApplicationsFilterExcludes, hasCompactFileLocationRecord, hasFlatWizardColours, headerFlagCount } from "./version"

/** Compression method the header declares for the installer's data. */
export type InnoCompression = "stored" | "zlib" | "bzip2" | "lzma1" | "lzma2"

const COMPRESSIONS: readonly InnoCompression[] = ["stored", "zlib", "bzip2", "lzma1", "lzma2"]

/** The value that marks a file entry with no data of its own. */
export const NO_LOCATION = 0xffffffff

/** One entry of the `[Files]` section: where it should land, and which data entry it consumes. */
export interface InnoFileEntry {
  /** Destination as the script writes it, constants included, such as `{app}\Lib\x.dll`. */
  destination: string
  /** Index into the location table, or {@link NO_LOCATION} for an entry Setup builds itself. */
  location: number
}

/** One entry of the location table: where a file sits in the data stream, and what it hashes to. */
export interface InnoDataEntry {
  /** Offset of the compressed block, relative to the start of the data area. */
  chunkOffset: number
  /** Offset of the file INSIDE the decompressed block. */
  fileOffset: number
  /** Size of the file once put back together. */
  fileSize: number
  /** SHA-256 of the reconstructed file, filter applied. */
  sha256: Uint8Array
  /** True when the compiler transformed `CALL` and `JMP` addresses to compress the executable better. */
  callInstructionOptimized: boolean
  /** True when the block is encrypted, which this reader refuses. */
  encrypted: boolean
  /** True when the block is compressed with the header's method. */
  compressed: boolean
}

export interface InnoSetupScript {
  version: InnoSetupVersion
  compression: InnoCompression
  files: readonly InnoFileEntry[]
  dataEntries: readonly InnoDataEntry[]
}

interface HeaderCounts {
  languages: number
  messages: number
  permissions: number
  types: number
  components: number
  tasks: number
  directories: number
  files: number
  dataEntries: number
  icons: number
  iniEntries: number
  registryEntries: number
  deleteEntries: number
  uninstallDeleteEntries: number
  runEntries: number
  uninstallRunEntries: number
  compression: InnoCompression
}

/**
 * Reads the two decompressed header blocks into the shape an extraction uses.
 *
 * @param version The format version, already checked as one this reader follows.
 * @param primary The decompressed first block, holding the script.
 * @param secondary The decompressed second block, holding the location table.
 */
export function readSetupScript(version: InnoSetupVersion, primary: Uint8Array, secondary: Uint8Array): InnoSetupScript {
  const reader = new InnoRecordReader(primary)
  const { counts, files } = readPrimaryBlock(reader, version)
  const dataEntries = readDataEntries(new InnoRecordReader(secondary), version, counts.dataEntries)

  return { version, compression: counts.compression, files, dataEntries }
}

function readPrimaryBlock(reader: InnoRecordReader, version: InnoSetupVersion): { counts: HeaderCounts; files: InnoFileEntry[] } {
  const counts = readHeader(reader, version)

  repeat(reader, counts.languages, readLanguage)
  repeat(reader, counts.messages, readMessage)
  repeat(reader, counts.permissions, (r) => r.skipString())
  repeat(reader, counts.types, readType)
  repeat(reader, counts.components, readComponent)
  repeat(reader, counts.tasks, readTask)
  repeat(reader, counts.directories, readDirectory)

  const files: InnoFileEntry[] = []
  for (let i = 0; i < counts.files; i++) files.push(readFile(reader))

  repeat(reader, counts.icons, readIcon)
  repeat(reader, counts.iniEntries, readIni)
  repeat(reader, counts.registryEntries, readRegistry)
  repeat(reader, counts.deleteEntries + counts.uninstallDeleteEntries, readDelete)
  repeat(reader, counts.runEntries + counts.uninstallRunEntries, readRun)

  readWizardImages(reader)
  readWizardImages(reader)

  // The embedded decompression library, present only for the methods that are
  // not inside Setup itself. LZMA2 is not one of them.
  if (counts.compression === "bzip2" || counts.compression === "zlib") reader.skipString()

  if (reader.remaining !== 0) throw InnoFormatError.corrupt(`${reader.remaining} unexpected bytes at the end of the main header block`)

  return { counts, files }
}

/**
 * The order and the presence of each field come from the Inno Setup sources
 * (`Projects/Src/Shared.Struct.pas`), cross read against innoextract. Nothing is
 * guessed: what is not certain is refused higher up, by the version filter.
 */
function readHeader(reader: InnoRecordReader, version: InnoSetupVersion): HeaderCounts {
  // Thirty two description strings: names, URLs, default paths, mutexes,
  // architecture expressions. None is of use to an extraction, all have to be
  // crossed.
  for (let i = 0; i < 32; i++) reader.skipString()

  if (hasCloseApplicationsFilterExcludes(version)) reader.skipString()

  // Licence, information texts, and the bytecode of the [Code] section.
  for (let i = 0; i < 4; i++) reader.skipString()

  const languages = reader.readCount()
  const messages = reader.readCount()
  const permissions = reader.readCount()
  const types = reader.readCount()
  const components = reader.readCount()
  const tasks = reader.readCount()
  const directories = reader.readCount()
  const files = reader.readCount()
  const dataEntries = reader.readCount()
  const icons = reader.readCount()
  const iniEntries = reader.readCount()
  const registryEntries = reader.readCount()
  const deleteEntries = reader.readCount()
  const uninstallDeleteEntries = reader.readCount()
  const runEntries = reader.readCount()
  const uninstallRunEntries = reader.readCount()

  reader.skipWindowsVersionRange()

  if (!hasFlatWizardColours(version)) reader.skip(8) // two background colours, dropped by Inno Setup 6.4.0.1

  reader.skip(1) // wizard style
  reader.skip(8) // resize percentages
  reader.skip(1) // image alpha format
  reader.skip(4) // start of the password hash
  reader.skip(44) // key derivation salt, iterations and nonce
  reader.skip(8) // extra disk space required
  reader.skip(4) // slices per disk
  reader.skip(1) // uninstall log mode
  reader.skip(1) // existing directory warning
  reader.skip(1) // privileges required
  reader.readFlags(2) // allowed privilege overrides
  reader.skip(1) // show language dialog
  reader.skip(1) // language detection

  const compressionByte = reader.readByte()

  reader.skip(1) // directory page disabled
  reader.skip(1) // group page disabled
  reader.skip(8) // size shown in Programs and Features

  reader.readFlags(headerFlagCount(version))

  const compression = COMPRESSIONS[compressionByte]
  if (!compression) throw InnoFormatError.unsupported(`unknown compression method (${compressionByte})`)

  return {
    languages,
    messages,
    permissions,
    types,
    components,
    tasks,
    directories,
    files,
    dataEntries,
    icons,
    iniEntries,
    registryEntries,
    deleteEntries,
    uninstallDeleteEntries,
    runEntries,
    uninstallRunEntries,
    compression
  }
}

function readDataEntries(reader: InnoRecordReader, version: InnoSetupVersion, count: number): InnoDataEntry[] {
  const compact = hasCompactFileLocationRecord(version)
  const entries: InnoDataEntry[] = []

  for (let i = 0; i < count; i++) {
    reader.skip(4) // first slice
    reader.skip(4) // last slice
    const chunkOffset = reader.readUInt32()
    const fileOffset = reader.readUInt64()
    const fileSize = reader.readUInt64()
    reader.skip(8) // compressed block size
    const sha256 = reader.read(32).slice()
    reader.skip(8) // timestamp
    reader.skip(8) // file version

    // Inno Setup 6.4.3 dropped four flags and the signature byte, and
    // RENUMBERED the survivors. Reading the old layout over the new one would
    // shift every record by two bytes and hand the executable filter to the
    // wrong files.
    const flags = reader.readFlags(compact ? 5 : 9)
    if (!compact) reader.skip(1) // signature mode, gone in 6.4.3

    entries.push({
      chunkOffset,
      fileOffset,
      fileSize,
      sha256,
      callInstructionOptimized: (flags & (compact ? 1 << 2 : 1 << 4)) !== 0,
      encrypted: (flags & (compact ? 1 << 3 : 1 << 6)) !== 0,
      compressed: (flags & (compact ? 1 << 4 : 1 << 7)) !== 0
    })
  }

  if (reader.remaining !== 0) throw InnoFormatError.corrupt(`${reader.remaining} unexpected bytes at the end of the location block`)

  return entries
}

/**
 * Crosses `count` records of one kind.
 *
 * The format chains a dozen variable length tables and each one used to be a
 * loop of its own, twelve loops saying nothing beyond "and now this one".
 * Naming them once makes the ORDER of the tables readable at a glance, and that
 * order is the one thing there is to not get wrong.
 */
function repeat(reader: InnoRecordReader, count: number, read: (reader: InnoRecordReader) => void): void {
  for (let i = 0; i < count; i++) read(reader)
}

function readMessage(reader: InnoRecordReader): void {
  reader.skipString() // name
  reader.skipString() // value
  reader.skip(4) // language
}

function readCondition(reader: InnoRecordReader): void {
  // Components, tasks, languages, the check expression, then the two procedures
  // bracketing the entry's install.
  for (let i = 0; i < 6; i++) reader.skipString()
}

function readLanguage(reader: InnoRecordReader): void {
  for (let i = 0; i < 10; i++) reader.skipString()
  reader.skip(4) // language identifier
  reader.skip(16) // four font sizes
  reader.skip(1) // right to left
}

function readType(reader: InnoRecordReader): void {
  for (let i = 0; i < 4; i++) reader.skipString()
  reader.skipWindowsVersionRange()
  reader.readFlags(1)
  reader.skip(1) // setup type
  reader.skip(8) // size
}

function readComponent(reader: InnoRecordReader): void {
  for (let i = 0; i < 5; i++) reader.skipString()
  reader.skip(8) // extra disk space
  reader.skip(4) // level
  reader.skip(1) // used
  reader.skipWindowsVersionRange()
  reader.readFlags(5)
  reader.skip(8) // size
}

function readTask(reader: InnoRecordReader): void {
  for (let i = 0; i < 6; i++) reader.skipString()
  reader.skip(4) // level
  reader.skip(1) // used
  reader.skipWindowsVersionRange()
  reader.readFlags(5)
}

function readDirectory(reader: InnoRecordReader): void {
  reader.skipString()
  readCondition(reader)
  reader.skip(4) // attributes
  reader.skipWindowsVersionRange()
  reader.skip(2) // permission
  reader.readFlags(5)
}

function readFile(reader: InnoRecordReader): InnoFileEntry {
  reader.skipString() // source
  const destination = reader.readString()
  reader.skipString() // font name to install
  reader.skipString() // strong assembly name
  readCondition(reader)
  reader.skipWindowsVersionRange()

  const location = reader.readUInt32()

  reader.skip(4) // attributes
  reader.skip(8) // external size
  reader.skip(2) // permission
  reader.readFlags(32)
  reader.skip(1) // entry type

  return { destination, location }
}

function readIcon(reader: InnoRecordReader): void {
  for (let i = 0; i < 6; i++) reader.skipString()
  readCondition(reader)
  reader.skipString() // application user model id
  reader.skip(16) // toast activator CLSID
  reader.skipWindowsVersionRange()
  reader.skip(4) // icon index
  reader.skip(4) // show command
  reader.skip(1) // close on exit
  reader.skip(2) // hotkey
  reader.readFlags(6)
}

function readIni(reader: InnoRecordReader): void {
  for (let i = 0; i < 4; i++) reader.skipString()
  readCondition(reader)
  reader.skipWindowsVersionRange()
  reader.readFlags(5)
}

function readRegistry(reader: InnoRecordReader): void {
  reader.skipString() // key
  reader.skipString() // value name
  reader.skipString() // value
  readCondition(reader)
  reader.skipWindowsVersionRange()
  reader.skip(4) // hive
  reader.skip(2) // permission
  reader.skip(1) // value type
  reader.readFlags(12)
}

function readDelete(reader: InnoRecordReader): void {
  reader.skipString()
  readCondition(reader)
  reader.skipWindowsVersionRange()
  reader.skip(1) // target
}

function readRun(reader: InnoRecordReader): void {
  for (let i = 0; i < 7; i++) reader.skipString()
  readCondition(reader)
  reader.skipWindowsVersionRange()
  reader.skip(4) // show command
  reader.skip(1) // wait condition
  reader.readFlags(12)
}

function readWizardImages(reader: InnoRecordReader): void {
  const count = reader.readCount()
  for (let i = 0; i < count; i++) reader.skipString()
}
