/**
 * CRC-32 with the reflected IEEE 802.3 polynomial `0xEDB88320`, which is what
 * Inno Setup guards its header blocks with.
 *
 * Written here rather than pulled from a package: the specification is one
 * table, it has not moved in forty years, and a test vector proves it. The
 * contrast with LZMA is deliberate and the criterion is the same one that
 * settles both, since that one is a complete entropy decoder.
 */
const POLYNOMIAL = 0xedb88320

const TABLE = buildTable()

function buildTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let entry = i
    for (let bit = 0; bit < 8; bit++) entry = (entry & 1) !== 0 ? (entry >>> 1) ^ POLYNOMIAL : entry >>> 1
    table[i] = entry >>> 0
  }
  return table
}

/**
 * Checksum of a byte range.
 *
 * @param data Buffer to read.
 * @param start First byte to include, defaults to the start of the buffer.
 * @param end One past the last byte to include, defaults to the end.
 * @returns The checksum as an unsigned 32 bit number.
 */
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) crc = TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
