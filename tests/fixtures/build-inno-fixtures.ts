/**
 * Hand-builds the tiny Inno Setup fixtures under tests/fixtures/inno/ that
 * tests/domain/inno/extract.test.ts reads the extractor against, so the
 * refusals in src/domain/inno are exercised on real installer bytes rather than
 * only through hand-made objects.
 *
 * Run this by hand after changing it, `npx tsx tests/fixtures/build-inno-fixtures.ts`,
 * and commit the files it writes. The generation itself only runs when the file
 * is executed directly (checked below by inspecting `process.argv[1]`): every
 * builder function is also exported, and tests/domain/inno/script.test.ts
 * imports them to build primary/secondary header buffers straight in memory,
 * without going through a whole installer file or the loader search. Importing
 * this module for that must not re-write the committed fixtures as a side
 * effect, which is the one thing this guard exists for.
 *
 * Every fixture declares STORED compression, so the payload is the file bytes
 * laid end to end and every record can be reasoned about by eye. What the
 * fixtures pin down is the LAYOUT, which is the part a reader gets wrong: the
 * order of the tables, the width of every skipped field, the location record
 * (87 bytes before Inno Setup 6.4.3, 85 after), and the stored size of a block
 * counting its own CRC prefixes. The LZMA decoding is covered separately,
 * against streams a real compressor produced (see build-lzma-fixtures.ts).
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { hasCloseApplicationsFilterExcludes, hasCompactFileLocationRecord, hasFlatWizardColours, headerFlagCount, type InnoSetupVersion } from "../../src/domain/inno/version"
import { NO_LOCATION } from "../../src/domain/inno/script"

const FIXTURES_DIR = join(__dirname, "inno")

const LOADER_MAGIC = Buffer.from([0x72, 0x44, 0x6c, 0x50, 0x74, 0x53, 0xcd, 0xe6, 0xd7, 0x7b, 0x0b, 0x2a])
export const CHUNK_MAGIC = Buffer.from([0x7a, 0x6c, 0x62, 0x1a])
const ID_LENGTH = 64
const BLOCK_CHUNK_BYTES = 4096

/** The compression byte the format defines, in the order src/domain/inno/script.ts reads it. */
const COMPRESSION_BYTES: Record<string, number> = { stored: 0, zlib: 1, bzip2: 2, lzma1: 3, lzma2: 4 }

/** CRC-32 with the reflected IEEE polynomial, the one Inno Setup guards its blocks with. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let entry = i
    for (let bit = 0; bit < 8; bit++) entry = (entry & 1) !== 0 ? (entry >>> 1) ^ 0xedb88320 : entry >>> 1
    table[i] = entry >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Splits a plain `major.minor.patch[.revision]` string, the same shape
 * src/domain/inno/version.ts reads out of the identification block. Kept
 * separate from that parser because this one is not defending against
 * adversarial bytes, only turning a fixture's own version string into the
 * object the version-switch predicates take.
 */
export function parseVersion(text: string): InnoSetupVersion {
  const parts = text.split(".").map(Number)
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0, revision: parts[3] ?? 0 }
}

/** Append only byte writer, in the shapes the format uses. */
export class Writer {
  private readonly parts: Buffer[] = []

  bytes(value: Buffer): this {
    this.parts.push(value)
    return this
  }

  zeros(count: number): this {
    return this.bytes(Buffer.alloc(count))
  }

  byte(value: number): this {
    return this.bytes(Buffer.from([value]))
  }

  u32(value: number): this {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(value >>> 0, 0)
    return this.bytes(buffer)
  }

  u64(value: number): this {
    const buffer = Buffer.alloc(8)
    buffer.writeUInt32LE(value % 0x100000000, 0)
    buffer.writeUInt32LE(Math.floor(value / 0x100000000), 4)
    return this.bytes(buffer)
  }

  /** A string as the format stores it: byte length, then UTF-16LE. */
  string(value: string): this {
    const encoded = Buffer.from(value, "utf16le")
    return this.u32(encoded.length).bytes(encoded)
  }

  strings(count: number): this {
    for (let i = 0; i < count; i++) this.string("")
    return this
  }

  /**
   * A packed flag set, one byte per eight declared flags, three byte sets
   * padded to four, `value`'s bits laid out little endian the way
   * InnoRecordReader.readFlags reads them back.
   */
  flags(declared: number, value = 0): this {
    const count = Math.ceil(declared / 8)
    const bufferLength = count === 3 ? 4 : count
    const buffer = Buffer.alloc(bufferLength)
    for (let i = 0; i < Math.min(4, bufferLength); i++) buffer.writeUInt8((value >>> (8 * i)) & 0xff, i)
    return this.bytes(buffer)
  }

  /** Two Windows version bounds of ten bytes each. */
  windowsVersionRange(): this {
    return this.zeros(20)
  }

  /** The six strings a condition holds: components, tasks, languages, check, before, after. */
  condition(): this {
    return this.strings(6)
  }

  build(): Buffer {
    return Buffer.concat(this.parts)
  }
}

/** One entry of the location table: the bytes it declares, and which chunk it lands in. */
export interface DataEntrySpec {
  contents: Buffer
  /** Overrides the size written into the location record, to build a lying entry. */
  declaredSize?: number
  /** Overrides the digest written into the location record, to build a lying entry. */
  declaredSha256?: Buffer
  /**
   * Groups entries into separate physical data blocks, each its own
   * CHUNK_MAGIC-prefixed run in the payload area. Entries sharing a group are
   * laid end to end, in array order; entries in different groups land in
   * different blocks, at growing chunk offsets. Defaults to 0, the single
   * block every fixture used before multi-chunk fixtures existed.
   */
  chunkGroup?: number
  callInstructionOptimized?: boolean
  encrypted?: boolean
  compressed?: boolean
  /**
   * Overrides the DECLARED fileOffset written into the location record,
   * independent of where this entry's bytes actually sit in the payload area.
   * For building a location table that lies about the order its own stream
   * holds, which is all extract.ts's "entries of a block do not follow each
   * other" guard exists to catch; the physical bytes stay wherever
   * `chunkGroup` and array order put them; only the metadata a reader trusts
   * is wrong here.
   */
  declaredFileOffset?: number
}

/** One entry of the `[Files]` section: where it should land, and which data entry it consumes. */
export interface FileSpec {
  destination: string
  /**
   * The common case: this entry owns its data, folded into the installer's
   * `dataEntries` automatically at build time, one data entry per file entry
   * that sets this. Leave unset (with `location` set instead, or neither) for
   * an entry that shares another's data, or carries none of its own.
   */
  contents?: Buffer
  declaredSize?: number
  declaredSha256?: Buffer
  /**
   * Explicit index into the installer's data entries, for a file that shares
   * data with another (two destinations, one location) or that was built
   * against a standalone `dataEntries` array rather than `contents`. Defaults
   * to this entry's own position among the entries that set `contents`.
   */
  location?: number
}

export interface InstallerSpec {
  /** The version string written into the identification block. */
  version: string
  /**
   * Version the header BYTES are laid out for. Defaults to `version`. Kept
   * apart so a fixture can declare one version in its identification string
   * while the bytes follow another's layout, which is what every
   * "wrong version claimed" fixture needs: the mismatch is the point, and it
   * has to survive whatever else changes about how these bytes are built.
   */
  layoutVersion?: string
  files: FileSpec[]
  /** Overrides file-derived data entries outright, for fixtures that need entries no file references directly. */
  dataEntries?: DataEntrySpec[]
  languages?: number
  messages?: number
  permissions?: number
  types?: number
  components?: number
  tasks?: number
  directories?: number
  icons?: number
  iniEntries?: number
  registryEntries?: number
  deleteEntries?: number
  uninstallDeleteEntries?: number
  runEntries?: number
  uninstallRunEntries?: number
  wizardImages?: number
  wizardSmallImages?: number
  /** Compression the header declares. Defaults to "stored", the only one whose payload this generator can actually produce. */
  compression?: "stored" | "zlib" | "bzip2" | "lzma1" | "lzma2"
  /** Raw override for the compression byte, for a value naming nothing the format defines. Takes precedence over `compression`. */
  compressionByte?: number
  /**
   * Chunk groups whose payload block gets genuinely LZMA2-compressed by `xz`
   * (preset 6, dictionary size byte 22) rather than stored as raw bytes.
   * Every data entry in such a group needs `compressed: true` of its own, and
   * `compression: "lzma2"` on the spec, for the location record and the
   * header to say what the bytes actually are.
   */
  lzma2ChunkGroups?: number[]
}

/** Resolves a spec's file entries and data entries against each other, however they were declared. */
function resolveDataEntries(spec: InstallerSpec): { dataEntries: DataEntrySpec[]; fileLocations: number[] } {
  if (spec.dataEntries) {
    return { dataEntries: spec.dataEntries, fileLocations: spec.files.map((file) => file.location ?? NO_LOCATION) }
  }

  const dataEntries: DataEntrySpec[] = []
  const fileLocations: number[] = []

  for (const file of spec.files) {
    if (file.location !== undefined) {
      fileLocations.push(file.location)
      continue
    }
    if (file.contents === undefined) {
      fileLocations.push(NO_LOCATION)
      continue
    }
    fileLocations.push(dataEntries.length)
    dataEntries.push({ contents: file.contents, declaredSize: file.declaredSize, declaredSha256: file.declaredSha256 })
  }

  return { dataEntries, fileLocations }
}

/** Where each data entry lands: its chunk's base offset, and its own offset inside that chunk. */
interface DataEntryLayout {
  chunkOffset: number
  fileOffset: number
}

/**
 * Lays entries out by chunk group, in array order within a group. An empty
 * entry does not advance the running offset, so it shares its slot with
 * whatever follows it in the same group, exactly like Setup's own writer: an
 * empty file takes no space, so there is nothing to place it after.
 */
function layoutDataEntries(dataEntries: readonly DataEntrySpec[]): DataEntryLayout[] {
  const groups = new Map<number, number[]>() // group -> indices, in array order
  dataEntries.forEach((entry, index) => {
    const group = entry.chunkGroup ?? 0
    const indices = groups.get(group)
    if (indices) indices.push(index)
    else groups.set(group, [index])
  })

  const layout: DataEntryLayout[] = new Array(dataEntries.length)
  let chunkOffset = 0

  for (const group of [...groups.keys()].sort((a, b) => a - b)) {
    let within = 0
    for (const index of groups.get(group)!) {
      const entry = dataEntries[index]!
      layout[index] = { chunkOffset, fileOffset: within }
      within += entry.contents.length
    }
    chunkOffset += CHUNK_MAGIC.length + within
  }

  return layout
}

function writeMessage(writer: Writer): void {
  writer.string("") // name
  writer.string("") // value
  writer.zeros(4) // language
}

function writeType(writer: Writer): void {
  writer.strings(4)
  writer.windowsVersionRange()
  writer.flags(1)
  writer.zeros(1) // setup type
  writer.zeros(8) // size
}

function writeComponent(writer: Writer): void {
  writer.strings(5)
  writer.zeros(8) // extra disk space
  writer.zeros(4) // level
  writer.zeros(1) // used
  writer.windowsVersionRange()
  writer.flags(5)
  writer.zeros(8) // size
}

function writeTask(writer: Writer): void {
  writer.strings(6)
  writer.zeros(4) // level
  writer.zeros(1) // used
  writer.windowsVersionRange()
  writer.flags(5)
}

function writeDirectory(writer: Writer): void {
  writer.string("")
  writer.condition()
  writer.zeros(4) // attributes
  writer.windowsVersionRange()
  writer.zeros(2) // permission
  writer.flags(5)
}

function writeLanguage(writer: Writer): void {
  writer.strings(10)
  writer.zeros(4) // language identifier
  writer.zeros(16) // four font sizes
  writer.zeros(1) // right to left
}

function writeIcon(writer: Writer): void {
  writer.strings(6)
  writer.condition()
  writer.string("") // application user model id
  writer.zeros(16) // toast activator CLSID
  writer.windowsVersionRange()
  writer.zeros(4) // icon index
  writer.zeros(4) // show command
  writer.zeros(1) // close on exit
  writer.zeros(2) // hotkey
  writer.flags(6)
}

function writeIni(writer: Writer): void {
  writer.strings(4)
  writer.condition()
  writer.windowsVersionRange()
  writer.flags(5)
}

function writeRegistry(writer: Writer): void {
  writer.strings(3) // key, value name, value
  writer.condition()
  writer.windowsVersionRange()
  writer.zeros(4) // hive
  writer.zeros(2) // permission
  writer.zeros(1) // value type
  writer.flags(12)
}

function writeDelete(writer: Writer): void {
  writer.string("")
  writer.condition()
  writer.windowsVersionRange()
  writer.zeros(1) // target
}

function writeRun(writer: Writer): void {
  writer.strings(7)
  writer.condition()
  writer.windowsVersionRange()
  writer.zeros(4) // show command
  writer.zeros(1) // wait condition
  writer.flags(12)
}

function writeWizardImages(writer: Writer, count: number): void {
  writer.u32(count)
  writer.strings(count)
}

/**
 * The main header block, in the exact order src/domain/inno/script.ts crosses
 * it. Every count defaults to zero, so a spec that only sets `files` builds
 * the same minimal block the original fixtures always did.
 */
export function buildPrimaryBlock(spec: InstallerSpec): Buffer {
  const version = parseVersion(spec.layoutVersion ?? spec.version)
  const writer = new Writer()
  const { dataEntries, fileLocations } = resolveDataEntries(spec)

  writer.strings(32) // names, URLs, default paths, mutexes, architecture expressions
  if (hasCloseApplicationsFilterExcludes(version)) writer.strings(1) // CloseApplicationsFilterExcludes, added by 6.4.2
  writer.strings(4) // licence, information texts, [Code] bytecode

  const counts = [
    spec.languages ?? 0,
    spec.messages ?? 0,
    spec.permissions ?? 0,
    spec.types ?? 0,
    spec.components ?? 0,
    spec.tasks ?? 0,
    spec.directories ?? 0,
    spec.files.length,
    dataEntries.length,
    spec.icons ?? 0,
    spec.iniEntries ?? 0,
    spec.registryEntries ?? 0,
    spec.deleteEntries ?? 0,
    spec.uninstallDeleteEntries ?? 0,
    spec.runEntries ?? 0,
    spec.uninstallRunEntries ?? 0
  ]
  for (const count of counts) writer.u32(count)

  writer.windowsVersionRange()
  if (!hasFlatWizardColours(version)) writer.zeros(8) // two background colours, dropped by Inno Setup 6.4.0.1
  writer.byte(0) // wizard style
  writer.zeros(8) // resize percentages
  writer.byte(0) // image alpha format
  writer.zeros(4) // start of the password hash
  writer.zeros(44) // key derivation salt, iterations and nonce
  writer.zeros(8) // extra disk space required
  writer.zeros(4) // slices per disk
  writer.byte(0) // uninstall log mode
  writer.byte(0) // existing directory warning
  writer.byte(0) // privileges required
  writer.flags(2) // allowed privilege overrides
  writer.byte(0) // show language dialog
  writer.byte(0) // language detection

  const compressionByte = spec.compressionByte ?? COMPRESSION_BYTES[spec.compression ?? "stored"]!
  writer.byte(compressionByte)

  writer.byte(0) // directory page disabled
  writer.byte(0) // group page disabled
  writer.zeros(8) // size shown in Programs and Features
  writer.flags(headerFlagCount(version))

  for (let i = 0; i < (spec.languages ?? 0); i++) writeLanguage(writer)
  for (let i = 0; i < (spec.messages ?? 0); i++) writeMessage(writer)
  for (let i = 0; i < (spec.permissions ?? 0); i++) writer.string("")
  for (let i = 0; i < (spec.types ?? 0); i++) writeType(writer)
  for (let i = 0; i < (spec.components ?? 0); i++) writeComponent(writer)
  for (let i = 0; i < (spec.tasks ?? 0); i++) writeTask(writer)
  for (let i = 0; i < (spec.directories ?? 0); i++) writeDirectory(writer)

  for (const [index, file] of spec.files.entries()) {
    writer.string("") // source
    writer.string(file.destination)
    writer.string("") // font name to install
    writer.string("") // strong assembly name
    writer.condition()
    writer.windowsVersionRange()
    writer.u32(fileLocations[index]!)
    writer.zeros(4) // attributes
    writer.zeros(8) // external size
    writer.zeros(2) // permission
    writer.flags(32)
    writer.byte(0) // entry type
  }

  for (let i = 0; i < (spec.icons ?? 0); i++) writeIcon(writer)
  for (let i = 0; i < (spec.iniEntries ?? 0); i++) writeIni(writer)
  for (let i = 0; i < (spec.registryEntries ?? 0); i++) writeRegistry(writer)
  for (let i = 0; i < (spec.deleteEntries ?? 0) + (spec.uninstallDeleteEntries ?? 0); i++) writeDelete(writer)
  for (let i = 0; i < (spec.runEntries ?? 0) + (spec.uninstallRunEntries ?? 0); i++) writeRun(writer)

  writeWizardImages(writer, spec.wizardImages ?? 0)
  writeWizardImages(writer, spec.wizardSmallImages ?? 0)

  // The embedded decompression library, present only for the methods that are
  // not inside Setup itself. LZMA1 and LZMA2 are not among them.
  if (compressionByte === COMPRESSION_BYTES.bzip2 || compressionByte === COMPRESSION_BYTES.zlib) writer.string("")

  return writer.build()
}

/**
 * The location block: one record per entry, 85 bytes each from Inno Setup
 * 6.4.3 on, 87 before it (a `Sign` byte and four more flags that 6.4.3 dropped
 * and renumbered).
 */
export function buildSecondaryBlock(spec: InstallerSpec): Buffer {
  const version = parseVersion(spec.layoutVersion ?? spec.version)
  const compact = hasCompactFileLocationRecord(version)
  const writer = new Writer()
  const { dataEntries } = resolveDataEntries(spec)
  const layout = layoutDataEntries(dataEntries)

  dataEntries.forEach((entry, index) => {
    const { chunkOffset, fileOffset } = layout[index]!
    writer.zeros(4) // first slice
    writer.zeros(4) // last slice
    writer.u32(chunkOffset)
    writer.u64(entry.declaredFileOffset ?? fileOffset)
    writer.u64(entry.declaredSize ?? entry.contents.length)
    writer.u64(entry.contents.length) // compressed block size
    writer.bytes(entry.declaredSha256 ?? createHash("sha256").update(entry.contents).digest())
    writer.zeros(8) // timestamp
    writer.zeros(8) // file version

    const callBit = compact ? 1 << 2 : 1 << 4
    const encryptedBit = compact ? 1 << 3 : 1 << 6
    const compressedBit = compact ? 1 << 4 : 1 << 7
    const value = (entry.callInstructionOptimized ? callBit : 0) | (entry.encrypted ? encryptedBit : 0) | (entry.compressed ? compressedBit : 0)

    writer.flags(compact ? 5 : 9, value)
    if (!compact) writer.byte(0) // signature mode, gone in 6.4.3
  })

  return writer.build()
}

/**
 * Wraps a payload as a header block: a CRC of the head, a STORED size counting
 * the whole block, then chunks of at most 4096 bytes each behind their own CRC.
 */
export function wrapBlock(payload: Buffer): Buffer {
  const chunks: Buffer[] = []
  for (let at = 0; at < payload.length; at += BLOCK_CHUNK_BYTES) {
    const chunk = payload.subarray(at, Math.min(payload.length, at + BLOCK_CHUNK_BYTES))
    const crc = Buffer.alloc(4)
    crc.writeUInt32LE(crc32(chunk), 0)
    chunks.push(crc, chunk)
  }

  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(5)
  head.writeUInt32LE(body.length, 0)
  head.writeUInt8(0, 4) // not compressed

  const crc = Buffer.alloc(4)
  crc.writeUInt32LE(crc32(head), 0)

  return Buffer.concat([crc, head, body])
}

export function buildIdentification(version: string): Buffer {
  const id = Buffer.alloc(ID_LENGTH)
  id.write(`Inno Setup Setup Data (${version})`, 0, "ascii")
  return id
}

/** Assembles a whole installer: a stub carrying the loader, the data area, then the header. */
export function buildInstaller(spec: InstallerSpec): Buffer {
  const { dataEntries } = resolveDataEntries(spec)
  const lzma2Groups = new Set(spec.lzma2ChunkGroups ?? [])
  const groupIds = [...new Set(dataEntries.map((entry) => entry.chunkGroup ?? 0))].sort((a, b) => a - b)

  const payloadParts: Buffer[] = []
  for (const groupId of groupIds) {
    const entries = dataEntries.filter((entry) => (entry.chunkGroup ?? 0) === groupId)
    const raw = Buffer.concat(entries.map((entry) => entry.contents))
    payloadParts.push(CHUNK_MAGIC)
    if (lzma2Groups.has(groupId)) {
      // Dictionary size byte 22: preset 6's 8 MiB, the same one
      // build-lzma-fixtures.ts names for its own raw LZMA2 stream.
      payloadParts.push(Buffer.from([22]))
      payloadParts.push(execFileSync("xz", ["--format=raw", "--lzma2=preset=6", "-c"], { input: raw, maxBuffer: 1 << 24 }))
    } else {
      payloadParts.push(raw)
    }
  }
  const payload = Buffer.concat(payloadParts)

  const stubLength = 256
  const dataOffset = stubLength
  const headerOffset = dataOffset + payload.length

  const stub = Buffer.alloc(stubLength)
  LOADER_MAGIC.copy(stub, 32)
  const table = new Writer()
    .u32(1)
    .zeros(4 * 4)
    .u32(headerOffset)
    .u32(dataOffset)
    .build()
  table.copy(stub, 32 + LOADER_MAGIC.length)

  return Buffer.concat([stub, payload, buildIdentification(spec.version), wrapBlock(buildPrimaryBlock(spec)), wrapBlock(buildSecondaryBlock(spec))])
}

function write(name: string, contents: Buffer): void {
  writeFileSync(join(FIXTURES_DIR, name), contents)
  console.log(`${name}: ${contents.length} bytes`)
}

const VALID: InstallerSpec = {
  version: "6.4.3",
  files: [
    { destination: "{app}\\Vintagestory.exe", contents: Buffer.from("MZ fake executable\n") },
    { destination: "{app}\\assets\\version-1.0.0.txt", contents: Buffer.from("1.0.0\n") },
    // Not under {app}: crossed, and never written.
    { destination: "{fonts}\\Lora.ttf", contents: Buffer.from("font bytes\n") }
  ]
}

function generateFixtures(): void {
  mkdirSync(FIXTURES_DIR, { recursive: true })

  write("valid.bin", buildInstaller(VALID))

  // The file stops in the middle of the location block, which is what a download
  // cut short looks like from the reader's side.
  const truncated = buildInstaller(VALID)
  write("truncated-header.bin", truncated.subarray(0, truncated.length - 40))

  // One byte of the main block's payload flipped, so its chunk CRC no longer lands.
  const badCrc = buildInstaller(VALID)
  badCrc[badCrc.length - 24] = badCrc[badCrc.length - 24]! ^ 0xff
  write("bad-block-crc.bin", badCrc)

  write(
    "path-traversal.bin",
    buildInstaller({
      version: "6.4.3",
      files: [{ destination: "{app}\\..\\..\\escaped.txt", contents: Buffer.from("nope\n") }]
    })
  )

  write(
    "oversized-entry.bin",
    buildInstaller({
      version: "6.4.3",
      files: [{ destination: "{app}\\huge.bin", contents: Buffer.from("small\n"), declaredSize: 3 * 1024 * 1024 * 1024 }]
    })
  )

  write(
    "wrong-digest.bin",
    buildInstaller({
      version: "6.4.3",
      files: [{ destination: "{app}\\Vintagestory.exe", contents: Buffer.from("MZ fake executable\n"), declaredSha256: Buffer.alloc(32, 0x11) }]
    })
  )

  write("unsupported-version.bin", buildInstaller({ ...VALID, version: "6.5.0" }))

  // Nothing destined for the version folder, so there is nothing to install.
  write(
    "no-app-files.bin",
    buildInstaller({
      version: "6.4.3",
      files: [{ destination: "{fonts}\\Lora.ttf", contents: Buffer.from("font bytes\n") }]
    })
  )

  // The location record moved between 6.4.2 and 6.4.3, so a fixture that
  // declares the older version over the newer layout has to be refused rather
  // than read. `layoutVersion` pins the bytes at 6.4.3 (what this generator
  // always built here) while `version` claims 6.4.1.
  write("mismatched-layout.bin", buildInstaller({ ...VALID, version: "6.4.1", layoutVersion: "6.4.3" }))

  // Two destinations, one data entry: the installer stores the file once and
  // the extractor has to write it out twice.
  write(
    "multi-destination.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [{ contents: Buffer.from("shared bytes\n") }],
      files: [
        { destination: "{app}\\A.txt", location: 0 },
        { destination: "{app}\\nested\\B.txt", location: 0 }
      ]
    })
  )

  // Same data entry, two destinations that differ only by case: one write, not two.
  write(
    "duplicate-destination-case.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [{ contents: Buffer.from("shared bytes\n") }],
      files: [
        { destination: "{app}\\Same.txt", location: 0 },
        { destination: "{app}\\SAME.txt", location: 0 }
      ]
    })
  )

  // Two data entries in two distinct chunks, so the extractor's stream-order
  // planning has to close one chunk and open a second one.
  write(
    "multi-chunk.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [
        { contents: Buffer.from("first chunk contents\n"), chunkGroup: 0 },
        { contents: Buffer.from("second chunk contents\n"), chunkGroup: 1 }
      ],
      files: [
        { destination: "{app}\\first.txt", location: 0 },
        { destination: "{app}\\second.txt", location: 1 }
      ]
    })
  )

  // An empty file shares its offset with whatever follows it in the same
  // chunk, since it takes up no space. The size-based tie-break in
  // extract.ts's planner is what keeps this ordering unambiguous.
  write(
    "empty-file-tie-break.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [
        { contents: Buffer.alloc(0), chunkGroup: 0 },
        { contents: Buffer.from("not empty\n"), chunkGroup: 0 }
      ],
      files: [
        { destination: "{app}\\empty.txt", location: 0 },
        { destination: "{app}\\filled.txt", location: 1 }
      ]
    })
  )

  // A whole installer at 6.4.0 (flags the compact record introduced in 6.4.3
  // did not exist yet, background colours still present) and at 6.4.2 (the
  // colours are already gone, CloseApplicationsFilterExcludes exists, but the
  // location record is still the 87 byte one), both genuinely valid rather
  // than mismatched, so an end to end extraction has to succeed on either.
  write("valid-6.4.0.bin", buildInstaller({ ...VALID, version: "6.4.0" }))
  write("valid-6.4.2.bin", buildInstaller({ ...VALID, version: "6.4.2" }))

  // Two entries the planner has to skip before it reaches a real one: a file
  // Setup builds itself (no location at all) and a file whose location index
  // names no data entry that exists.
  write(
    "unused-location-entries.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [{ contents: Buffer.from("kept bytes\n") }],
      files: [{ destination: "{app}\\generated.ini" }, { destination: "{app}\\phantom.bin", location: 99 }, { destination: "{app}\\kept.txt", location: 0 }]
    })
  )

  // An entry the location table marks encrypted, which this reader refuses
  // outright rather than attempt.
  write(
    "encrypted-entry.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [{ contents: Buffer.from("secret\n"), encrypted: true }],
      files: [{ destination: "{app}\\locked.bin", location: 0 }]
    })
  )

  // A file the compiler CALL/JMP-optimized, so extraction has to undo the
  // filter before the digest is checked. 0xE8 at offset 0 addresses the byte
  // after it; an absolute address of 5 is a relative displacement of zero,
  // the same fixture format.test.ts uses for the filter alone.
  write(
    "call-optimized-entry.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [
        {
          // The digest the installer declares is of the RECONSTRUCTED file
          // (the filter undone), the same as the one verifyDigest computes
          // after undoCallInstructionFilter runs, not of these stored bytes.
          contents: Buffer.from([0xe8, 0x05, 0x00, 0x00, 0x00]),
          callInstructionOptimized: true,
          declaredSha256: createHash("sha256")
            .update(Buffer.from([0xe8, 0x00, 0x00, 0x00, 0x00]))
            .digest()
        }
      ],
      files: [{ destination: "{app}\\filtered.bin", location: 0 }]
    })
  )

  // A skipped {fonts} entry sits physically between two kept {app} entries in
  // the same chunk, so the second one's stream has to be discarded past
  // before it can be read.
  write(
    "gap-between-entries.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [{ contents: Buffer.from("first\n") }, { contents: Buffer.from("skipped bytes in between\n") }, { contents: Buffer.from("second\n") }],
      files: [
        { destination: "{app}\\first.txt", location: 0 },
        { destination: "{fonts}\\Skipped.ttf", location: 1 },
        { destination: "{app}\\second.txt", location: 2 }
      ]
    })
  )

  // Two entries in one chunk whose DECLARED offsets run backwards: the second
  // claims to start before the first one ends, which the location table
  // itself never actually produces but a truncated or hand-edited installer
  // could.
  write(
    "out-of-order-offsets.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [{ contents: Buffer.from("0123456789\n") }, { contents: Buffer.from("abcde\n"), declaredFileOffset: 3 }],
      files: [
        { destination: "{app}\\a.bin", location: 0 },
        { destination: "{app}\\b.bin", location: 1 }
      ]
    })
  )

  // A data block whose leading marker is not the four bytes the format always
  // opens a block with.
  const badMagic = buildInstaller(VALID)
  // The payload area starts right after the 256 byte stub, and opens with
  // CHUNK_MAGIC.
  badMagic[256] = badMagic[256]! ^ 0xff
  write("bad-chunk-magic.bin", badMagic)

  // A real LZMA2-compressed block, solid over two files, so the extractor's
  // own decompression path (as opposed to lzma.test.ts's direct decoder
  // tests) gets exercised end to end: openChunk's compressed branch, and the
  // pull-stream driving Lzma2Decoder chunk by chunk.
  write(
    "lzma2-payload.bin",
    buildInstaller({
      version: "6.4.3",
      compression: "lzma2",
      lzma2ChunkGroups: [0],
      dataEntries: [
        { contents: Buffer.from("lzma2 first file, compressed for real\n".repeat(20)), compressed: true },
        { contents: Buffer.from("lzma2 second file, sharing the same solid block\n".repeat(20)), compressed: true }
      ],
      files: [
        { destination: "{app}\\first-compressed.txt", location: 0 },
        { destination: "{app}\\second-compressed.txt", location: 1 }
      ]
    })
  )

  // A skipped {fonts} entry sits between two kept entries inside a SOLID
  // LZMA2 block, so the extractor's compressed pull-stream (as opposed to the
  // stored one gap-between-entries.bin exercises) has to discard decoded
  // bytes rather than hand them out as the next file.
  write(
    "lzma2-gap.bin",
    buildInstaller({
      version: "6.4.3",
      compression: "lzma2",
      lzma2ChunkGroups: [0],
      dataEntries: [
        { contents: Buffer.from("kept first, lzma2 solid block\n".repeat(20)), compressed: true },
        { contents: Buffer.from("skipped bytes sitting in between, also part of the solid block\n".repeat(20)), compressed: true },
        { contents: Buffer.from("kept second, after the gap\n".repeat(20)), compressed: true }
      ],
      files: [
        { destination: "{app}\\lzma2-first.txt", location: 0 },
        { destination: "{fonts}\\Skipped.ttf", location: 1 },
        { destination: "{app}\\lzma2-second.txt", location: 2 }
      ]
    })
  )

  // Three files sized so the rounded percentage stays the same across two
  // consecutive writes (99% twice in a row before the last file reaches
  // 100%), so onProgress's "only report when the percentage actually moved"
  // guard has a repeat to swallow.
  write(
    "progress-plateau.bin",
    buildInstaller({
      version: "6.4.3",
      dataEntries: [{ contents: Buffer.alloc(980, 0x41) }, { contents: Buffer.from("a") }, { contents: Buffer.from("b") }],
      files: [
        { destination: "{app}\\big.bin", location: 0 },
        { destination: "{app}\\tiny-a.bin", location: 1 },
        { destination: "{app}\\tiny-b.bin", location: 2 }
      ]
    })
  )

  // A skipped {fonts} entry sits BEFORE the one kept file in a solid LZMA2
  // block, so the very first thing writePlan does with the stream is discard
  // straight off nothing yet decoded, rather than off a leftover from an
  // earlier read.
  write(
    "lzma2-leading-gap.bin",
    buildInstaller({
      version: "6.4.3",
      compression: "lzma2",
      lzma2ChunkGroups: [0],
      dataEntries: [
        { contents: Buffer.from("skipped, leads the block\n".repeat(20)), compressed: true },
        { contents: Buffer.from("kept, after the leading gap\n".repeat(20)), compressed: true }
      ],
      files: [
        { destination: "{fonts}\\Skipped.ttf", location: 0 },
        { destination: "{app}\\kept-after-gap.txt", location: 1 }
      ]
    })
  )

  // A declared file size the compressed stream cannot actually deliver: the
  // LZMA2 stream ends (its terminating control byte is read) while the reader
  // still wants more bytes for the entry it declares.
  write(
    "lzma2-declared-oversized.bin",
    buildInstaller({
      version: "6.4.3",
      compression: "lzma2",
      lzma2ChunkGroups: [0],
      dataEntries: [{ contents: Buffer.from("short\n"), compressed: true, declaredSize: 100_000 }],
      files: [{ destination: "{app}\\oversized-declared.bin", location: 0 }]
    })
  )

  // A method this reader never implements a decoder for: the header names
  // zlib, and the one entry is marked compressed, so extraction has to refuse
  // before it ever tries to open the block.
  write(
    "zlib-compressed-entry.bin",
    buildInstaller({
      version: "6.4.3",
      compression: "zlib",
      dataEntries: [{ contents: Buffer.from("not actually deflated\n"), compressed: true }],
      files: [{ destination: "{app}\\would-be-deflated.bin", location: 0 }]
    })
  )
}

if (process.argv[1] && (process.argv[1].endsWith("build-inno-fixtures.ts") || process.argv[1].endsWith("build-inno-fixtures.js"))) {
  generateFixtures()
}
