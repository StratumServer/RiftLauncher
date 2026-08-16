/**
 * The two offsets that open an Inno Setup installer: the one for the header and
 * the one for the data.
 *
 * The loader lives in a PE resource that Setup finds through the executable
 * format's own table of contents. This reader looks for it by its marker instead
 * of walking that table: far less code to write and keep, for a decision that
 * has no right to be taken on the strength of a marker anyway. Every candidate
 * is therefore CHECKED, and the search carries on while a candidate does not
 * hold up. The offsets have to stay inside the file, follow each other in the
 * right order, and the header has to actually carry an Inno Setup identification
 * string. A twelve byte pattern landing by chance inside a resource passes none
 * of those three.
 */
import { InnoFormatError } from "./errors"
import type { InnoInstallerFile } from "./ports"
import { ID_LENGTH, parseInnoSetupVersion } from "./version"

/** Loader markers, in the two shapes modern Inno Setup uses. */
const MAGICS: readonly Uint8Array[] = [
  new Uint8Array([0x72, 0x44, 0x6c, 0x50, 0x74, 0x53, 0xcd, 0xe6, 0xd7, 0x7b, 0x0b, 0x2a]),
  new Uint8Array([0x6e, 0x53, 0x35, 0x57, 0x37, 0x64, 0x54, 0x83, 0xaa, 0x1b, 0x0f, 0x6a])
]

/**
 * How much of the preamble is searched. The loader lives in the executable stub
 * at the front of the file; past that the game's data begins, where a search
 * would mean no longer and would cost a six hundred megabyte read.
 */
const SEARCH_WINDOW_BYTES = 16 * 1024 * 1024

/** The offset table that follows a marker: revision, a reserved word, the stub, its hash, then our two offsets. */
const TABLE_WORDS = 7

export interface InnoLoaderOffsets {
  /** Where the identification string that precedes the header blocks sits. */
  headerOffset: number
  /** Where the first data block sits. */
  dataOffset: number
}

/** Finds the offsets, or refuses the file. */
export async function findLoaderOffsets(file: InnoInstallerFile): Promise<InnoLoaderOffsets> {
  const haystack = await file.read(0, Math.min(SEARCH_WINDOW_BYTES, file.size))

  for (const magic of MAGICS) {
    let searched = 0
    for (;;) {
      const at = indexOf(haystack, magic, searched)
      if (at < 0) break
      searched = at + 1

      const candidate = readOffsets(haystack, at, file.size)
      if (candidate && (await confirm(file, candidate))) return candidate
    }
  }

  throw InnoFormatError.unsupported("no Inno Setup loader found in the file")
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length
  const first = needle[0]!
  for (let at = from; at <= last; at++) {
    if (haystack[at] !== first) continue
    let i = 1
    while (i < needle.length && haystack[at + i] === needle[i]) i++
    if (i === needle.length) return at
  }
  return -1
}

function readOffsets(haystack: Uint8Array, magicAt: number, fileSize: number): InnoLoaderOffsets | undefined {
  const tableAt = magicAt + 12
  if (tableAt + TABLE_WORDS * 4 > haystack.length) return undefined
  if (readUInt32(haystack, tableAt) !== 1) return undefined

  const headerOffset = readUInt32(haystack, tableAt + 5 * 4)
  const dataOffset = readUInt32(haystack, tableAt + 6 * 4)

  if (dataOffset === 0 || headerOffset <= dataOffset || headerOffset + ID_LENGTH > fileSize) return undefined
  return { headerOffset, dataOffset }
}

async function confirm(file: InnoInstallerFile, candidate: InnoLoaderOffsets): Promise<boolean> {
  const id = await file.read(candidate.headerOffset, ID_LENGTH)
  return id.length === ID_LENGTH && parseInnoSetupVersion(id) !== undefined
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
}
