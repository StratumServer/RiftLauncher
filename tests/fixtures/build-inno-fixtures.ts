/**
 * Hand-builds the tiny Inno Setup fixtures under tests/fixtures/inno/ that
 * tests/domain/inno/extract.test.ts reads the extractor against, so the
 * refusals in src/domain/inno are exercised on real installer bytes rather than
 * only through hand-made objects.
 *
 * This script is not run by the test suite. It is the documentation of what each
 * fixture contains: run it by hand after changing it,
 * `npx tsx tests/fixtures/build-inno-fixtures.ts`, and commit the files it
 * writes alongside the change.
 *
 * Every fixture declares STORED compression, so the payload is the file bytes
 * laid end to end and every record can be reasoned about by eye. What the
 * fixtures pin down is the LAYOUT, which is the part a reader gets wrong: the
 * order of the tables, the width of every skipped field, the 85 byte location
 * record of Inno Setup 6.4.3, and the stored size of a block counting its own
 * CRC prefixes. The LZMA decoding is covered separately, against streams a real
 * compressor produced (see build-lzma-fixtures.ts).
 */
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const FIXTURES_DIR = join(__dirname, "inno")

const LOADER_MAGIC = Buffer.from([0x72, 0x44, 0x6c, 0x50, 0x74, 0x53, 0xcd, 0xe6, 0xd7, 0x7b, 0x0b, 0x2a])
const CHUNK_MAGIC = Buffer.from([0x7a, 0x6c, 0x62, 0x1a])
const ID_LENGTH = 64
const BLOCK_CHUNK_BYTES = 4096
const COMPRESSION_STORED = 0

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

/** Append only byte writer, in the shapes the format uses. */
class Writer {
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

  /** A packed flag set, one byte per eight declared flags, three byte sets padded to four. */
  flags(declared: number, value = 0): this {
    const count = Math.ceil(declared / 8)
    const buffer = Buffer.alloc(count === 3 ? 4 : count)
    buffer.writeUInt8(value & 0xff, 0)
    return this.bytes(buffer)
  }

  /** Two Windows version bounds of ten bytes each. */
  windowsVersionRange(): this {
    return this.zeros(20)
  }

  build(): Buffer {
    return Buffer.concat(this.parts)
  }
}

interface FileSpec {
  /** Destination as the script writes it, constants included. */
  destination: string
  contents: Buffer
  /** Overrides the size written into the location record, to build a lying entry. */
  declaredSize?: number
  /** Overrides the digest written into the location record, to build a lying entry. */
  declaredSha256?: Buffer
}

interface InstallerSpec {
  /** The version string written into the identification block. */
  version: string
  files: FileSpec[]
}

/**
 * The main header block, in the exact order src/domain/inno/script.ts crosses
 * it. Every count but the file count is zero, so the tables that follow are
 * empty and only the file table has to be written.
 */
function buildPrimaryBlock(spec: InstallerSpec): Buffer {
  const writer = new Writer()

  writer.strings(32) // names, URLs, default paths, mutexes, architecture expressions
  writer.strings(1) // CloseApplicationsFilterExcludes, added by 6.4.2
  writer.strings(4) // licence, information texts, [Code] bytecode

  const counts = [0, 0, 0, 0, 0, 0, 0, spec.files.length, spec.files.length, 0, 0, 0, 0, 0, 0, 0]
  for (const count of counts) writer.u32(count)

  writer.windowsVersionRange()
  // No background colours: 6.4.0.1 removed them, and every fixture is above it.
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
  writer.byte(COMPRESSION_STORED)
  writer.byte(0) // directory page disabled
  writer.byte(0) // group page disabled
  writer.zeros(8) // size shown in Programs and Features
  writer.flags(44) // header options

  for (const [index, file] of spec.files.entries()) {
    writer.string("") // source
    writer.string(file.destination)
    writer.string("") // font name to install
    writer.string("") // strong assembly name
    writer.strings(6) // condition: components, tasks, languages, check, before, after
    writer.windowsVersionRange()
    writer.u32(index)
    writer.zeros(4) // attributes
    writer.zeros(8) // external size
    writer.zeros(2) // permission
    writer.flags(32)
    writer.byte(0) // entry type
  }

  writer.u32(0) // wizard images
  writer.u32(0) // wizard small images

  return writer.build()
}

/** The location block: one 85 byte record per entry, as Inno Setup 6.4.3 writes it. */
function buildSecondaryBlock(spec: InstallerSpec): Buffer {
  const writer = new Writer()
  let offset = 0

  for (const file of spec.files) {
    writer.zeros(4) // first slice
    writer.zeros(4) // last slice
    writer.u32(0) // chunk offset: every fixture holds one block
    writer.u64(offset)
    writer.u64(file.declaredSize ?? file.contents.length)
    writer.u64(file.contents.length) // compressed block size
    writer.bytes(file.declaredSha256 ?? createHash("sha256").update(file.contents).digest())
    writer.zeros(8) // timestamp
    writer.zeros(8) // file version
    writer.flags(5) // five flags, none set: not filtered, not encrypted, not compressed
    offset += file.contents.length
  }

  return writer.build()
}

/**
 * Wraps a payload as a header block: a CRC of the head, a STORED size counting
 * the whole block, then chunks of at most 4096 bytes each behind their own CRC.
 */
function wrapBlock(payload: Buffer): Buffer {
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

function buildIdentification(version: string): Buffer {
  const id = Buffer.alloc(ID_LENGTH)
  id.write(`Inno Setup Setup Data (${version})`, 0, "ascii")
  return id
}

/** Assembles a whole installer: a stub carrying the loader, the data area, then the header. */
function buildInstaller(spec: InstallerSpec): Buffer {
  const payload = Buffer.concat(spec.files.map((file) => file.contents))
  const stubLength = 256
  const dataOffset = stubLength
  const headerOffset = dataOffset + CHUNK_MAGIC.length + payload.length

  const stub = Buffer.alloc(stubLength)
  LOADER_MAGIC.copy(stub, 32)
  const table = new Writer()
    .u32(1)
    .zeros(4 * 4)
    .u32(headerOffset)
    .u32(dataOffset)
    .build()
  table.copy(stub, 32 + LOADER_MAGIC.length)

  return Buffer.concat([stub, CHUNK_MAGIC, payload, buildIdentification(spec.version), wrapBlock(buildPrimaryBlock(spec)), wrapBlock(buildSecondaryBlock(spec))])
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

// The location record moved between 6.4.2 and 6.4.3, so a fixture that declares
// the older version over the newer layout has to be refused rather than read.
write("mismatched-layout.bin", buildInstaller({ ...VALID, version: "6.4.1" }))
