/**
 * Getting the game out of an Inno Setup installer WITHOUT running it.
 *
 * This is the point of the whole folder, and the reason is not speed: it is that
 * none of the installer's SCRIPT is played. No script played means no
 * "an old version was detected" MsgBox from `InitializeSetup`, which
 * `/SUPPRESSMSGBOXES` cannot answer and which hung a silent run on the record,
 * and no uninstall key written, so no dialog the next time either.
 *
 * What is laid down is only the entries destined for `{app}`, that is the game.
 * The fonts the script installs into the system folder, its registry keys, its
 * shortcuts and its final launch are crossed and left alone: a version installed
 * this way lives entirely inside its own folder, and the Linux build of the game
 * (a plain `.tar.gz` with no side effect whatsoever) is the proof that none of
 * that is what makes the game start.
 *
 * Every file written is checked against the SHA-256 the installer declares for
 * it. That is what makes a hand written format reader trustworthy: a wrong
 * layout does not quietly produce a broken game, it fails on the first digest
 * and the install stops.
 */
import { readHeaderBlock } from "./blocks"
import { undoCallInstructionFilter } from "./callFilter"
import { InstallerCursor } from "./cursor"
import { InnoFormatError } from "./errors"
import { findLoaderOffsets } from "./loader"
import { Lzma2Decoder } from "./lzma"
import { relativeAppPath, safeRelativePath } from "./paths"
import type { InnoExtractionPorts } from "./ports"
import type { InnoCompression, InnoDataEntry, InnoSetupScript } from "./script"
import { NO_LOCATION, readSetupScript } from "./script"
import { formatVersion, ID_LENGTH, requireSupportedVersion } from "./version"

/** Marker every data block opens with. */
const CHUNK_MAGIC = [0x7a, 0x6c, 0x62, 0x1a]

/**
 * Size past which an entry is refused. The largest file in the game weighs a few
 * tens of megabytes; this bound guards against a size read crooked asking for an
 * absurd buffer.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

/** Staging for decoded bytes. One LZMA2 chunk yields at most 2 MiB, so this always holds one. */
const STAGING_BYTES = 4 * 1024 * 1024

/** One data entry and every place under the version folder it has to land. */
interface PlannedFile {
  entry: InnoDataEntry
  paths: string[]
}

export interface InnoExtractionResult {
  /** Format version the installer declared, as it spells it. */
  version: string
  compression: InnoCompression
  /** How many files were written. */
  filesWritten: number
  /** How many bytes those files hold. */
  bytesWritten: number
}

export interface InnoExtractionOptions {
  /** Called as the work advances, with a fraction between 0 and 1. */
  onProgress?: (fraction: number) => void
}

/**
 * Extracts the game into the sink.
 *
 * @param ports The installer to read, how to hash, and where files go.
 * @param options Progress reporting.
 * @throws {InnoFormatError} On an unknown format, an inconsistent read, or a
 * digest that does not match. The caller falls back to running the installer.
 */
export async function extractInnoPayload(ports: InnoExtractionPorts, options: InnoExtractionOptions = {}): Promise<InnoExtractionResult> {
  const { installer } = ports
  const offsets = await findLoaderOffsets(installer)

  const cursor = new InstallerCursor(installer)
  cursor.seek(offsets.headerOffset)
  const version = requireSupportedVersion(await cursor.readExactly(ID_LENGTH))

  const primary = await readHeaderBlock(cursor)
  const secondary = await readHeaderBlock(cursor)
  const script = readSetupScript(version, primary, secondary)

  const planned = buildPlan(script)
  const totalBytes = planned.reduce((sum, file) => sum + file.entry.fileSize, 0)

  const written = await writePlan(ports, script, offsets.dataOffset, planned, totalBytes, options.onProgress)

  return { version: formatVersion(version), compression: script.compression, filesWritten: written, bytesWritten: totalBytes }
}

/**
 * Sorts what has to be written into the order the stream will hand it over: by
 * block, then by position inside the block.
 *
 * A data block is a SOLID compressed stream: there is no seeking inside it, only
 * unrolling. Extracting in script order would mean unrolling it from the start
 * for every file, that is hundreds of megabytes decompressed twenty thousand
 * times. Reading in stream order, crossing without writing the entries that are
 * of no interest, unrolls it once.
 */
export function buildPlan(script: InnoSetupScript): PlannedFile[] {
  const destinations = collectDestinationsByLocation(script)
  if (destinations.size === 0) throw InnoFormatError.corrupt("no file destined for the install folder")

  const planned: PlannedFile[] = []
  for (const [location, paths] of destinations) {
    const entry = script.dataEntries[location]!
    if (entry.encrypted) throw InnoFormatError.unsupported("encrypted data")
    if (entry.fileSize > MAX_FILE_BYTES) throw InnoFormatError.corrupt(`an entry of ${entry.fileSize} bytes`)
    planned.push({ entry, paths })
  }

  planned.sort(byStreamOrder)

  return planned
}

/**
 * Gathers every destination under the version folder, keyed by the data entry
 * that feeds it.
 *
 * One data entry can serve SEVERAL destinations: the installer stores content
 * it lays down twice only once, and the game's fonts are exactly that case,
 * one copy under {app} and one in the system font folder. Indexing by location
 * rather than by destination is what keeps the stream read to one pass, but
 * every destination of each has to be kept, otherwise the day two paths under
 * {app} share content one of them would go missing without a word.
 */
function collectDestinationsByLocation(script: InnoSetupScript): Map<number, string[]> {
  const destinations = new Map<number, string[]>()

  for (const file of script.files) {
    if (file.location === NO_LOCATION || file.location >= script.dataEntries.length) continue

    const stored = relativeAppPath(file.destination)
    if (stored === undefined) continue

    const relativePath = safeRelativePath(stored)
    if (relativePath === undefined) throw InnoFormatError.corrupt(`a destination outside the version folder: "${file.destination}"`)

    const paths = destinations.get(file.location)
    if (!paths) {
      destinations.set(file.location, [relativePath])
      continue
    }
    // Two entries can aim at the same destination under different install
    // conditions, the 32 and 64 bit variants among them. One write is enough.
    if (!paths.some((known) => known.toLowerCase() === relativePath.toLowerCase())) paths.push(relativePath)
  }

  return destinations
}

/**
 * Orders two planned files the way the stream hands them over: by block, then
 * by position inside the block.
 *
 * The size breaks ties, and that is not a flourish: an EMPTY file shares its
 * offset with the one that follows, since it takes up nothing. Sorting by
 * growing size puts the empty file first, where reading zero bytes bothers
 * nobody.
 */
function byStreamOrder(left: PlannedFile, right: PlannedFile): number {
  if (left.entry.chunkOffset !== right.entry.chunkOffset) return left.entry.chunkOffset - right.entry.chunkOffset
  if (left.entry.fileOffset !== right.entry.fileOffset) return left.entry.fileOffset - right.entry.fileOffset
  return left.entry.fileSize - right.entry.fileSize
}

async function writePlan(
  ports: InnoExtractionPorts,
  script: InnoSetupScript,
  dataOffset: number,
  planned: readonly PlannedFile[],
  totalBytes: number,
  onProgress?: (fraction: number) => void
): Promise<number> {
  const cursor = new InstallerCursor(ports.installer)
  let done = 0
  let lastPercent = -1
  let filesWritten = 0
  let index = 0

  while (index < planned.length) {
    const chunkOffset = planned[index]!.entry.chunkOffset
    let last = index
    while (last + 1 < planned.length && planned[last + 1]!.entry.chunkOffset === chunkOffset) last++

    const stream = await openChunk(cursor, script, dataOffset, planned[index]!.entry)
    let position = 0

    for (let at = index; at <= last; at++) {
      const { entry, paths } = planned[at]!
      if (entry.fileOffset < position) throw InnoFormatError.corrupt("the entries of a block do not follow each other")

      await stream.discard(entry.fileOffset - position)
      const contents = await stream.read(entry.fileSize)
      position = entry.fileOffset + entry.fileSize

      if (entry.callInstructionOptimized) undoCallInstructionFilter(contents)
      verifyDigest(ports, contents, entry, paths[0]!)

      for (const relativePath of paths) {
        await ports.sink.writeFile(relativePath, contents)
        filesWritten++
      }

      done += entry.fileSize
      if (onProgress && totalBytes > 0) {
        const percent = Math.floor((done / totalBytes) * 100)
        // One install lays down twenty thousand files, and every report crosses
        // a thread boundary. Reporting per file would flood the display to paint
        // the same pixel a hundred times.
        if (percent !== lastPercent) {
          lastPercent = percent
          onProgress(done / totalBytes)
        }
      }
    }

    index = last + 1
  }

  return filesWritten
}

function verifyDigest(ports: InnoExtractionPorts, contents: Uint8Array, entry: InnoDataEntry, relativePath: string): void {
  const digest = ports.digest.hash(contents)
  if (digest.length !== entry.sha256.length) throw InnoFormatError.corrupt(`the digest for "${relativePath}" is the wrong length`)
  for (let i = 0; i < digest.length; i++) {
    if (digest[i] !== entry.sha256[i]) throw InnoFormatError.corrupt(`the SHA-256 of "${relativePath}" does not match what the installer declares`)
  }
}

/** A block's decompressed bytes, pulled in order. */
interface ChunkStream {
  read(length: number): Promise<Uint8Array>
  discard(count: number): Promise<void>
}

async function openChunk(cursor: InstallerCursor, script: InnoSetupScript, dataOffset: number, entry: InnoDataEntry): Promise<ChunkStream> {
  cursor.seek(dataOffset + entry.chunkOffset)
  const magic = await cursor.readExactly(4)
  for (let i = 0; i < CHUNK_MAGIC.length; i++) {
    if (magic[i] !== CHUNK_MAGIC[i]) throw InnoFormatError.corrupt("a data block is missing its marker")
  }

  if (!entry.compressed) return storedStream(cursor)
  if (script.compression !== "lzma2") throw InnoFormatError.unsupported(`${script.compression} compressed data`)

  const properties = await cursor.readExactly(1)
  return lzma2Stream(cursor, properties[0]!)
}

function storedStream(cursor: InstallerCursor): ChunkStream {
  return {
    read: async (length): Promise<Uint8Array> => (await cursor.readExactly(length)).slice(),
    discard: async (count): Promise<void> => {
      let remaining = count
      while (remaining > 0) {
        const take = Math.min(remaining, STAGING_BYTES)
        await cursor.readExactly(take)
        remaining -= take
      }
    }
  }
}

/**
 * Drives the LZMA2 decoder as a pull stream.
 *
 * Decoded bytes land in one staging buffer that is only refilled once it has
 * been drained, which is what lets the decoder hand out views onto its own
 * dictionary without anything copying them twice.
 */
function lzma2Stream(cursor: InstallerCursor, dictionaryProperties: number): ChunkStream {
  const staging = new Uint8Array(STAGING_BYTES)
  let start = 0
  let end = 0

  const decoder = new Lzma2Decoder(dictionaryProperties, (bytes) => {
    if (end + bytes.length > staging.length) throw InnoFormatError.corrupt("an LZMA2 chunk produced more than the format allows")
    staging.set(bytes, end)
    end += bytes.length
  })

  const pump = async (): Promise<void> => {
    start = 0
    end = 0
    const produced = await decoder.decodeChunk(cursor)
    if (produced === 0 && end === 0) throw InnoFormatError.corrupt("the data stream ended before the entries it declares")
  }

  return {
    read: async (length): Promise<Uint8Array> => {
      const target = new Uint8Array(length)
      let written = 0
      while (written < length) {
        if (start === end) await pump()
        const take = Math.min(end - start, length - written)
        target.set(staging.subarray(start, start + take), written)
        start += take
        written += take
      }
      return target
    },
    discard: async (count): Promise<void> => {
      let remaining = count
      while (remaining > 0) {
        if (start === end) await pump()
        const take = Math.min(end - start, remaining)
        start += take
        remaining -= take
      }
    }
  }
}
