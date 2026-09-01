/**
 * A sequential cursor over one decompressed header block.
 *
 * The block has NO index and NO markers: it is a run of records glued end to
 * end, each of variable length, and the position of one is only known by having
 * read all of the previous one. Skipping a field, or reading one field too many,
 * raises no error there and then. It shifts everything after it, and what comes
 * out next are sizes and paths that look plausible and are wrong. Hence two
 * rules here. Every field the format declares is CONSUMED, even the ones with no
 * use. And any read past the end of the block throws rather than returning
 * zeroes.
 *
 * This covers the 6.4 family, where every integer is 32 bits and every string is
 * UTF-16LE. The 16 bit variants and the code pages of the installers before Inno
 * Setup 6 have no reason to exist here: those versions are refused earlier.
 */
import { InnoFormatError } from "./errors"

/**
 * A count read out of the header is never trusted straight.
 *
 * A wild count is the symptom of a shifted read, and looping on it would mean
 * allocating gigabytes before noticing.
 */
const MAX_DECLARED_COUNT = 4_000_000

export class InnoRecordReader {
  private at = 0

  constructor(private readonly data: Uint8Array) {}

  /** Bytes still unread. */
  get remaining(): number {
    return this.data.length - this.at
  }

  /** Reads `count` raw bytes as a view onto the block. */
  read(count: number): Uint8Array {
    if (count < 0 || count > this.remaining) throw InnoFormatError.corrupt(`a read of ${count} bytes at offset ${this.at} left only ${this.remaining} in the block`)
    const slice = this.data.subarray(this.at, this.at + count)
    this.at += count
    return slice
  }

  /** Steps over `count` bytes without interpreting them. */
  skip(count: number): void {
    this.read(count)
  }

  readByte(): number {
    return this.read(1)[0]!
  }

  readUInt32(): number {
    const bytes = this.read(4)
    return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0
  }

  /** Reads a 64 bit little endian integer as a JavaScript number, refusing anything past the safe range. */
  readUInt64(): number {
    const low = this.readUInt32()
    const high = this.readUInt32()
    if (high > 0x001fffff) throw InnoFormatError.corrupt(`a 64 bit field holds ${high}:${low}, past what can be counted exactly`)
    return high * 0x100000000 + low
  }

  /**
   * Steps over a string stored as a byte length then its bytes, without decoding
   * it.
   *
   * Most of the header's strings are of no use here, and crossing them without
   * building a JavaScript string saves tens of thousands of allocations on an
   * installer that holds more than twenty thousand entries.
   */
  skipString(): void {
    this.skip(this.readUInt32())
  }

  /** Reads a string stored as a byte length then UTF-16LE bytes. */
  readString(): string {
    const bytes = this.read(this.readUInt32())
    if (bytes.length % 2 !== 0) throw InnoFormatError.corrupt("a UTF-16 string holds an odd number of bytes")

    let text = ""
    // Built in slices so a long string does not blow the argument limit of
    // String.fromCodePoint, and so a short one still costs a single call.
    const step = 4096
    for (let start = 0; start < bytes.length; start += step * 2) {
      const end = Math.min(bytes.length, start + step * 2)
      const units: number[] = []
      for (let i = start; i < end; i += 2) units.push(bytes[i]! | (bytes[i + 1]! << 8))
      text += String.fromCodePoint(...units)
    }
    return text
  }

  /**
   * Reads a packed flag set: one byte per eight declared flags.
   *
   * How many flags there are depends on the version, and it is THAT which
   * decides how many bytes are consumed, which is why the caller passes it
   * rather than a default of one byte being read. Inno Setup also pads a three
   * byte set out to four, the one irregularity in the encoding.
   *
   * @param declaredFlags How many flags this version declares.
   * @returns The first 32 flag bits, low byte first. Sets are declared up to
   * forty nine flags wide and nothing here reads past the first byte of one, so
   * the rest is consumed and dropped rather than carried in a number that could
   * not hold it exactly.
   */
  readFlags(declaredFlags: number): number {
    const byteCount = Math.ceil(declaredFlags / 8)
    const bytes = this.read(byteCount)

    let value = 0
    for (let i = 0; i < Math.min(4, bytes.length); i++) value += bytes[i]! * Math.pow(2, 8 * i)
    if (byteCount === 3) this.skip(1)

    return value
  }

  /**
   * Steps over a Windows version range: two bounds of ten bytes each.
   *
   * Each bound carries a Windows version (16 bit build, minor, major), an NT
   * version in the same shape, and a service pack over two bytes. Nothing here
   * uses them, and everything here has to cross them: it is the most frequent
   * field of the format, present in almost every record.
   */
  skipWindowsVersionRange(): void {
    this.skip(20)
  }

  /** Reads a count, refusing one that could only come from a shifted read. */
  readCount(): number {
    const value = this.readUInt32()
    if (value > MAX_DECLARED_COUNT) throw InnoFormatError.corrupt(`an implausible entry count (${value})`)
    return value
  }
}
