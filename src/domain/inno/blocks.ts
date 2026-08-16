/**
 * Reading the two header blocks of an Inno Setup installer: the one describing
 * the script, then the one describing where the data sits.
 *
 * A block opens on a CRC32 of its own head, a STORED size and a compression
 * byte. Then comes a run of chunks of at most 4096 bytes, each one preceded by
 * its own CRC32. The trap in the format is that the stored size counts the WHOLE
 * block, CRC prefixes included, and not just the payload. Reading it as the
 * payload alone overshoots the Vintage Story header by a hundred and seventy two
 * bytes and breaks the last chunk.
 *
 * Every CRC is checked. They are not only there to catch a damaged file: above
 * all they confirm that the offset the read started at was the right one. A
 * false positive from the loader marker search ends in a CRC that does not land,
 * so in a refusal, never in a silently wrong extraction.
 *
 * The compressed payload is a raw LZMA1 stream: five property bytes, then the
 * data, with NO end marker. The decoder therefore stops when its input stops,
 * which is normal rather than an error.
 */
import { crc32 } from "./crc32"
import type { InstallerCursor } from "./cursor"
import { InnoFormatError } from "./errors"
import { decodeLzma1 } from "./lzma"

/** Largest chunk the format allows. */
const CHUNK_BYTES = 4096

/**
 * Refusal bound on a header block's decompressed size. A real header runs to a
 * few megabytes; past this, what is being read is not a header.
 */
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024

/**
 * Reads the block at the cursor and returns its decompressed contents, leaving
 * the cursor just after the block, ready for the next one.
 */
export async function readHeaderBlock(cursor: InstallerCursor): Promise<Uint8Array> {
  const head = await cursor.readExactly(9)
  const expectedCrc = readUInt32(head, 0)
  if (expectedCrc !== crc32(head, 4, 9)) throw InnoFormatError.corrupt("the CRC32 of a block header does not match")

  const storedSize = readUInt32(head, 4)
  const compressed = head[8] !== 0

  const payload = await readChunks(cursor, storedSize)

  if (!compressed) return payload
  if (payload.length < 5) throw InnoFormatError.corrupt("a compressed block is shorter than its LZMA header")
  return decodeLzma1(payload.subarray(0, 5), payload.subarray(5), MAX_DECOMPRESSED_BYTES)
}

/** Gathers the payload, checking the CRC32 of every chunk. */
async function readChunks(cursor: InstallerCursor, storedSize: number): Promise<Uint8Array> {
  if (storedSize > MAX_DECOMPRESSED_BYTES) throw InnoFormatError.corrupt(`a header block declares ${storedSize} stored bytes`)

  const pieces: Uint8Array[] = []
  let total = 0
  let remaining = storedSize

  while (remaining > 0) {
    if (remaining < 5) throw InnoFormatError.corrupt("a block ends on a truncated chunk")

    const crcBytes = await cursor.readExactly(4)
    const expected = readUInt32(crcBytes, 0)
    remaining -= 4

    const take = Math.min(CHUNK_BYTES, remaining)
    // Copied out: the cursor hands back a view onto a window it reuses.
    const chunk = (await cursor.readExactly(take)).slice()
    remaining -= take

    if (expected !== crc32(chunk)) throw InnoFormatError.corrupt("the CRC32 of a block chunk does not match")

    pieces.push(chunk)
    total += chunk.length
  }

  const payload = new Uint8Array(total)
  let at = 0
  for (const piece of pieces) {
    payload.set(piece, at)
    at += piece.length
  }
  return payload
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
}
