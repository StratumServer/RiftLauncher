/**
 * Hand-builds the tiny zip fixtures under tests/fixtures/ that
 * tests/ipc/modScan.test.ts reads readModArchive against, so the yauzl edge
 * cases in src/ipc/adapters/modScan.ts are exercised against real archive
 * bytes instead of only through the domain's fakes.
 *
 * This script is not run by the test suite. It is the documentation of what
 * each fixture contains: run it by hand after changing it,
 * `npx tsx tests/fixtures/build-fixtures.ts`, and commit the zips it writes
 * alongside the change.
 *
 * Every fixture but one uses STORE (method 0, no compression), because a
 * STORE entry is bytes the reader can be reasoned about by eye. The one
 * exception is understated-size-modinfo.zip: yauzl only lets a declared size
 * disagree with reality when there is an actual decompression step in the
 * way (see its builder below for why), so that one entry is DEFLATE.
 */
import { crc32, deflateRawSync } from "node:zlib"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const FIXTURES_DIR = __dirname

const SIG_LOCAL_HEADER = 0x04034b50
const SIG_CENTRAL_HEADER = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const ZIP64_SENTINEL = 0xffffffff

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** A DOS date/time pair. The value carries no meaning here; every reader just needs one present. */
const DOS_TIME = 0
const DOS_DATE = 0x21

interface EntrySpec {
  /** Name as it appears inside the archive, e.g. "modinfo.json". */
  name: string
  method: typeof METHOD_STORE | typeof METHOD_DEFLATE
  /** The real bytes backing the entry, before compression. */
  realBytes: Buffer
  /**
   * uncompressedSize as written into both headers. Defaults to `realBytes.length`.
   * Set this apart from the real length to build a lying entry, which only
   * yauzl will actually let through as far as a data stream for a DEFLATE
   * entry — see understated-size-modinfo.zip.
   */
  declaredUncompressedSize?: number
  /** Writes the size fields as the zip64 sentinel and carries the real sizes in a per-entry zip64 extra field. */
  zip64Entry?: boolean
}

interface BuiltEntry {
  name: string
  localPart: Buffer
  centralPart: Buffer
  offset: number
}

/** Lays out one entry's local header + name + data, and its central directory record, ready to be assembled. */
function buildEntry(spec: EntrySpec, offset: number): BuiltEntry {
  const nameBuf = Buffer.from(spec.name, "utf8")
  const crc = crc32(spec.realBytes)
  const storedBytes = spec.method === METHOD_DEFLATE ? deflateRawSync(spec.realBytes) : spec.realBytes
  const declaredUncompressed = spec.declaredUncompressedSize ?? spec.realBytes.length
  const declaredCompressed = storedBytes.length

  const useZip64 = spec.zip64Entry === true
  const localUncompressedField = useZip64 ? ZIP64_SENTINEL : declaredUncompressed
  const localCompressedField = useZip64 ? ZIP64_SENTINEL : declaredCompressed

  let localExtra = Buffer.alloc(0)
  let centralExtra = Buffer.alloc(0)
  if (useZip64) {
    // Zip64 extended information extra field (tag 0x0001): original size, then
    // compressed size, each 8 bytes LE, in that order, one entry per 32-bit
    // field that was set to the sentinel above.
    const zip64Data = Buffer.alloc(16)
    zip64Data.writeBigUInt64LE(BigInt(declaredUncompressed), 0)
    zip64Data.writeBigUInt64LE(BigInt(declaredCompressed), 8)
    const zip64Field = Buffer.alloc(4)
    zip64Field.writeUInt16LE(0x0001, 0)
    zip64Field.writeUInt16LE(zip64Data.length, 2)
    localExtra = Buffer.concat([zip64Field, zip64Data])
    centralExtra = localExtra
  }

  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(SIG_LOCAL_HEADER, 0)
  localHeader.writeUInt16LE(20, 4) // version needed to extract
  localHeader.writeUInt16LE(0, 6) // general purpose bit flag
  localHeader.writeUInt16LE(spec.method, 8)
  localHeader.writeUInt16LE(DOS_TIME, 10)
  localHeader.writeUInt16LE(DOS_DATE, 12)
  localHeader.writeUInt32LE(crc, 14)
  localHeader.writeUInt32LE(localCompressedField, 18)
  localHeader.writeUInt32LE(localUncompressedField, 22)
  localHeader.writeUInt16LE(nameBuf.length, 26)
  localHeader.writeUInt16LE(localExtra.length, 28)

  const localPart = Buffer.concat([localHeader, nameBuf, localExtra, storedBytes])

  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(SIG_CENTRAL_HEADER, 0)
  centralHeader.writeUInt16LE(20, 4) // version made by
  centralHeader.writeUInt16LE(20, 6) // version needed to extract
  centralHeader.writeUInt16LE(0, 8) // general purpose bit flag
  centralHeader.writeUInt16LE(spec.method, 10)
  centralHeader.writeUInt16LE(DOS_TIME, 12)
  centralHeader.writeUInt16LE(DOS_DATE, 14)
  centralHeader.writeUInt32LE(crc, 16)
  centralHeader.writeUInt32LE(localCompressedField, 20)
  centralHeader.writeUInt32LE(localUncompressedField, 24)
  centralHeader.writeUInt16LE(nameBuf.length, 28)
  centralHeader.writeUInt16LE(centralExtra.length, 30)
  centralHeader.writeUInt16LE(0, 32) // file comment length
  centralHeader.writeUInt16LE(0, 34) // disk number start
  centralHeader.writeUInt16LE(0, 36) // internal file attributes
  centralHeader.writeUInt32LE(0, 38) // external file attributes
  centralHeader.writeUInt32LE(offset, 42) // relative offset of local header

  const centralPart = Buffer.concat([centralHeader, nameBuf, centralExtra])

  return { name: spec.name, localPart, centralPart, offset }
}

/** Assembles a plain (non-zip64) archive: local entries, then the central directory, then a 32-bit EOCD. */
function assembleZip(specs: EntrySpec[]): Buffer {
  const parts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const spec of specs) {
    const built = buildEntry(spec, offset)
    parts.push(built.localPart)
    centralParts.push(built.centralPart)
    offset += built.localPart.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const centralDirectoryOffset = offset

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4) // number of this disk
  eocd.writeUInt16LE(0, 6) // disk where central directory starts
  eocd.writeUInt16LE(specs.length, 8) // central directory records on this disk
  eocd.writeUInt16LE(specs.length, 10) // total central directory records
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(centralDirectoryOffset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...parts, centralDirectory, eocd])
}

/**
 * Assembles an archive whose central directory is located through a Zip64 End
 * of Central Directory Record and Locator instead of read directly out of the
 * 32-bit EOCD. yauzl decides to take the zip64 path purely on whether the
 * locator signature is present right before the EOCD; it does not require any
 * entry, or the EOCD's own headline fields, to actually need the wider width.
 * The one entry here also uses a per-entry zip64 extra field, so both parts of
 * yauzl's zip64 handling run: the record locator and the extra field.
 */
function assembleZip64(specs: EntrySpec[]): Buffer {
  const parts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const spec of specs) {
    const built = buildEntry(spec, offset)
    parts.push(built.localPart)
    centralParts.push(built.centralPart)
    offset += built.localPart.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const centralDirectoryOffset = offset

  const zip64Eocd = Buffer.alloc(56)
  zip64Eocd.writeUInt32LE(SIG_ZIP64_EOCD, 0)
  zip64Eocd.writeBigUInt64LE(BigInt(44), 4) // size of this record, excluding the first 12 bytes
  zip64Eocd.writeUInt16LE(45, 12) // version made by
  zip64Eocd.writeUInt16LE(45, 14) // version needed to extract
  zip64Eocd.writeUInt32LE(0, 16) // number of this disk
  zip64Eocd.writeUInt32LE(0, 20) // disk with the start of the central directory
  zip64Eocd.writeBigUInt64LE(BigInt(specs.length), 24) // records on this disk
  zip64Eocd.writeBigUInt64LE(BigInt(specs.length), 32) // total records
  zip64Eocd.writeBigUInt64LE(BigInt(centralDirectory.length), 40) // size of the central directory
  zip64Eocd.writeBigUInt64LE(BigInt(centralDirectoryOffset), 48) // offset of the central directory

  const zip64EocdOffset = centralDirectoryOffset + centralDirectory.length

  const zip64Locator = Buffer.alloc(20)
  zip64Locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0)
  zip64Locator.writeUInt32LE(0, 4) // disk with the start of the zip64 EOCD
  zip64Locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8)
  zip64Locator.writeUInt32LE(1, 16) // total number of disks

  // The trailing 32-bit EOCD. yauzl overwrites entryCount and
  // centralDirectoryOffset from the zip64 record once it sees the locator, so
  // these headline fields are never actually read for this fixture; they are
  // still filled in as a real writer would, sentinelled where the true value
  // does not fit.
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(specs.length, 8)
  eocd.writeUInt16LE(specs.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(centralDirectoryOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, centralDirectory, zip64Eocd, zip64Locator, eocd])
}

function write(fileName: string, bytes: Buffer): void {
  writeFileSync(join(FIXTURES_DIR, fileName), bytes)
  process.stdout.write(`${fileName}\t${bytes.length} bytes\n`)
}

const validModinfo = Buffer.from(JSON.stringify({ modid: "riftfixture", name: "Rift Fixture Mod", version: "1.0.0" }), "utf8")
// A real PNG signature followed by a few filler bytes. readModArchive never
// decodes the icon, it only carries bytes through, so this only has to look
// like the real thing to a human reading a hex dump.
const modIcon = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture-icon-not-a-real-png")])

// --- valid-mod.zip -----------------------------------------------------
// A well formed archive: modinfo.json then modicon.png, both under their
// caps. readModArchive should resolve `{ ok: true, content: { modinfo, icon } }`.
write(
  "valid-mod.zip",
  assembleZip([
    { name: "modinfo.json", method: METHOD_STORE, realBytes: validModinfo },
    { name: "modicon.png", method: METHOD_STORE, realBytes: modIcon }
  ])
)

// --- modinfo-only.zip ----------------------------------------------------
// No modicon.png entry at all. The scan still has to resolve `ok: true` with
// `content.icon` left undefined, rather than waiting for an entry that will
// never come.
write("modinfo-only.zip", assembleZip([{ name: "modinfo.json", method: METHOD_STORE, realBytes: validModinfo }]))

// --- icon-before-modinfo.zip ----------------------------------------------
// Same two entries as valid-mod.zip, but modicon.png is listed first in the
// central directory. zip.on("entry") fires in central directory order, so
// this proves the result does not depend on which entry the archive's author
// happened to zip up first.
write(
  "icon-before-modinfo.zip",
  assembleZip([
    { name: "modicon.png", method: METHOD_STORE, realBytes: modIcon },
    { name: "modinfo.json", method: METHOD_STORE, realBytes: validModinfo }
  ])
)

// --- invalid-json-modinfo.zip ---------------------------------------------
// modinfo.json's bytes are not valid JSON. readModArchive only carries text
// out of the archive; it never parses it (that is src/domain/mods/modinfo.ts's
// job), so this still has to resolve `ok: true` with the malformed text intact.
write("invalid-json-modinfo.zip", assembleZip([{ name: "modinfo.json", method: METHOD_STORE, realBytes: Buffer.from("not valid json {{{", "utf8") }]))

// --- oversized-declared-modinfo.zip ---------------------------------------
// modinfo.json declares an uncompressedSize past the 1 MiB cap
// (MAX_MODINFO_BYTES in modScan.ts). declaredSizeAllowed() rejects this from
// the entry's declared size alone, before any stream is opened, so the real
// bytes behind the entry can stay tiny: they are never read.
//
// This has to be DEFLATE, not STORE: yauzl requires a STORE entry's declared
// compressedSize and uncompressedSize to match at parse time (method 0 has no
// compression step to make them differ), and matching both at 2 MiB would mean
// 2 MiB of real bytes in a fixture meant to stay under 1 KiB. A DEFLATE entry
// carries no such constraint between the two declared fields, so the real
// payload can stay a few bytes while only the declared uncompressed size lies.
write(
  "oversized-declared-modinfo.zip",
  assembleZip([
    {
      name: "modinfo.json",
      method: METHOD_DEFLATE,
      realBytes: Buffer.from("irrelevant", "utf8"),
      declaredUncompressedSize: 2 * 1024 * 1024
    }
  ])
)

// --- oversized-declared-icon.zip -------------------------------------------
// Same idea as oversized-declared-modinfo.zip, aimed at the icon's own,
// larger cap instead (MAX_MOD_IMAGE_BYTES, 512 KiB in modScan.ts). modinfo.json
// is valid and under its cap, so the archive gets as far as trying the icon.
// The declared size exceeds the limit, so the icon is skipped and the mod
// appears without a picture rather than as an error.
write(
  "oversized-declared-icon.zip",
  assembleZip([
    { name: "modinfo.json", method: METHOD_STORE, realBytes: validModinfo },
    {
      name: "modicon.png",
      method: METHOD_DEFLATE,
      realBytes: Buffer.from("irrelevant", "utf8"),
      declaredUncompressedSize: 1 * 1024 * 1024
    }
  ])
)

// --- understated-size-modinfo.zip (the crown jewel) -----------------------
// modScan.ts's own oversize guard is `collect()`'s running byte count against
// MAX_MODINFO_BYTES, added because the declared size in a zip's headers is
// whatever the archive's author wrote there, not a fact about the bytes that
// follow. A STORE entry cannot exercise the lie: yauzl requires
// compressedSize === uncompressedSize for method 0 and refuses the archive at
// parse time otherwise, and even when they match, the read stream is bounded
// to exactly that many physical bytes, so nothing can ever exceed what was
// declared.
//
// A DEFLATE entry can lie, because the declared uncompressedSize is a
// separate fact from the compressed byte range read off disk: yauzl inflates
// whatever is in that range and reports however many bytes came out, which
// does not have to match the header. This is also exactly the condition PR #25
// fixed: the pre-fix code's oversize branch called `stream.destroy()` without
// settling the archive's promise, and a destroyed stream emits neither `end`
// nor `error`, so the scan hung on the first archive that lied this way. Here,
// modinfo.json declares 10 bytes but actually decompresses to the real
// (valid) fixture payload above, which is far more than 10. yauzl's own
// AssertByteCountStream reaches the same conclusion before modScan.ts's own
// counter would (both are bounded by the same declared value, and yauzl's
// wrapper sits closer to the source), and turns it into a stream `error`
// event, which `collect()`'s `onUnreadable` settles from. Either guard firing
// proves the same property this fixture exists to prove: the archive settles,
// it does not hang.
write(
  "understated-size-modinfo.zip",
  assembleZip([
    {
      name: "modinfo.json",
      method: METHOD_DEFLATE,
      realBytes: validModinfo,
      declaredUncompressedSize: 10
    }
  ])
)

// --- zip64.zip --------------------------------------------------------
// A valid mod archive located through a Zip64 End of Central Directory Record
// and Locator instead of a plain 32-bit EOCD, with the one entry's own sizes
// carried in a per-entry zip64 extended information extra field rather than
// the fixed-width header fields. Small on disk: zip64 is a structural choice
// a writer can make regardless of how large the entries actually are, not
// something that only shows up past the 4 GiB mark, so this fits comfortably
// under the same size budget as the other fixtures.
write("zip64.zip", assembleZip64([{ name: "modinfo.json", method: METHOD_STORE, realBytes: validModinfo, zip64Entry: true }]))

// --- not-a-zip.bin ----------------------------------------------------
// Plain bytes, no zip structure anywhere in them. yauzl.open()'s own callback
// receives the error (no End of Central Directory Record signature found),
// before a single "entry" event, exercising readModArchive's openErr branch.
write("not-a-zip.bin", Buffer.from("this is not a zip archive, just some bytes", "utf8"))
