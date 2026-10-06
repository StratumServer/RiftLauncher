/**
 * Reads managed assembly references from a PE/CLI image.
 *
 * This follows the PE data directories and ECMA-335 metadata tables instead of
 * searching arbitrary DLL bytes, where namespaces, debug records and strings
 * such as InternalsVisibleTo can look like references without being one.
 */

type Column = "u16" | "u32" | "string" | "guid" | "blob" | `table:${number}` | `coded:${string}`

const CODED_INDICES: Readonly<Record<string, { bits: number; tables: readonly number[] }>> = {
  ResolutionScope: { bits: 2, tables: [0, 26, 35, 1] },
  TypeDefOrRef: { bits: 2, tables: [2, 1, 27] },
  MemberRefParent: { bits: 3, tables: [2, 1, 26, 6, 27] },
  HasConstant: { bits: 2, tables: [4, 8, 23] },
  HasCustomAttribute: { bits: 5, tables: [6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42, 44, 43] },
  CustomAttributeType: { bits: 3, tables: [6, 10] },
  HasFieldMarshal: { bits: 1, tables: [4, 8] },
  HasDeclSecurity: { bits: 2, tables: [2, 6, 32] },
  HasSemantics: { bits: 1, tables: [20, 23] },
  MethodDefOrRef: { bits: 1, tables: [6, 10] },
  MemberForwarded: { bits: 1, tables: [4, 6] }
}

const TABLES: readonly (readonly Column[])[] = [
  ["u16", "string", "guid", "guid", "guid"],
  ["coded:ResolutionScope", "string", "string"],
  ["u32", "string", "string", "coded:TypeDefOrRef", "table:4", "table:6"],
  ["table:4"],
  ["u16", "string", "blob"],
  ["table:6"],
  ["u32", "u16", "u16", "string", "blob", "table:8"],
  ["table:8"],
  ["u16", "u16", "string"],
  ["table:2", "coded:TypeDefOrRef"],
  ["coded:MemberRefParent", "string", "blob"],
  ["u16", "coded:HasConstant", "blob"],
  ["coded:HasCustomAttribute", "coded:CustomAttributeType", "blob"],
  ["coded:HasFieldMarshal", "blob"],
  ["u16", "coded:HasDeclSecurity", "blob"],
  ["u16", "u32", "table:2"],
  ["u32", "table:4"],
  ["blob"],
  ["table:2", "table:20"],
  ["table:20"],
  ["u16", "string", "coded:TypeDefOrRef"],
  ["table:2", "table:23"],
  ["table:23"],
  ["u16", "string", "blob"],
  ["u16", "table:6", "coded:HasSemantics"],
  ["table:2", "coded:MethodDefOrRef", "coded:MethodDefOrRef"],
  ["string"],
  ["blob"],
  ["u16", "coded:MemberForwarded", "string", "table:26"],
  ["u32", "table:4"],
  ["u32", "u32"],
  ["u32"],
  ["u32", "u16", "u16", "u16", "u16", "u32", "blob", "string", "string"],
  ["u32"],
  ["u32", "u32", "u32"]
]

function checkedRange(buffer: Buffer, offset: number, size: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > buffer.length) {
    throw new Error("Invalid managed assembly metadata range")
  }
}

function readU16(buffer: Buffer, offset: number): number {
  checkedRange(buffer, offset, 2)
  return buffer.readUInt16LE(offset)
}

function readU32(buffer: Buffer, offset: number): number {
  checkedRange(buffer, offset, 4)
  return buffer.readUInt32LE(offset)
}

function rvaToOffset(image: Buffer, rva: number, sections: readonly { address: number; size: number; raw: number; rawSize: number }[]): number {
  for (const section of sections) {
    const delta = rva - section.address
    if (delta >= 0 && delta < section.size && delta < section.rawSize && section.raw + delta < image.length) return section.raw + delta
  }
  throw new Error("Managed assembly RVA is outside its sections")
}

function peDirectoryOffsets(magic: number): { directories: number; count: number } | undefined {
  switch (magic) {
    case 0x10b:
      return { directories: 96, count: 92 }
    case 0x20b:
      return { directories: 112, count: 108 }
    default:
      return undefined
  }
}

function readMetadata(image: Buffer): Buffer {
  if (image.toString("ascii", 0, 2) !== "MZ") throw new Error("Not a PE image")
  const pe = readU32(image, 0x3c)
  if (image.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("Not a PE image")

  const sectionCount = readU16(image, pe + 6)
  const optionalSize = readU16(image, pe + 20)
  const optional = pe + 24
  const magic = readU16(image, optional)
  const offsets = peDirectoryOffsets(magic)
  if (!offsets || optionalSize < offsets.directories + 15 * 8 || readU32(image, optional + offsets.count) < 15) {
    throw new Error("PE image has no CLI directory")
  }

  const cliDirectory = optional + offsets.directories + 14 * 8
  const cliRva = readU32(image, cliDirectory)
  const cliSize = readU32(image, cliDirectory + 4)
  if (cliRva === 0 || cliSize < 72) throw new Error("PE image has no CLI directory")

  const sectionTable = optional + optionalSize
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const header = sectionTable + index * 40
    const virtualSize = readU32(image, header + 8)
    const rawSize = readU32(image, header + 16)
    return { address: readU32(image, header + 12), size: Math.max(virtualSize, rawSize), raw: readU32(image, header + 20), rawSize }
  })

  const cli = rvaToOffset(image, cliRva, sections)
  if (readU32(image, cli) < 72) throw new Error("CLI header is truncated")
  const metadataRva = readU32(image, cli + 8)
  const metadataSize = readU32(image, cli + 12)
  const metadata = rvaToOffset(image, metadataRva, sections)
  checkedRange(image, metadata, metadataSize)
  return image.subarray(metadata, metadata + metadataSize)
}

function readStreamMetadata(metadata: Buffer): { tables: Buffer; strings: Buffer } {
  if (readU32(metadata, 0) !== 0x424a5342) throw new Error("CLI metadata signature is invalid")
  const versionLength = readU32(metadata, 12)
  const streamCountOffset = (16 + versionLength + 3) & ~3
  const streamCount = readU16(metadata, streamCountOffset + 2)
  let cursor = streamCountOffset + 4
  const streams = new Map<string, Buffer>()

  for (let index = 0; index < streamCount; index += 1) {
    const offset = readU32(metadata, cursor)
    const size = readU32(metadata, cursor + 4)
    const nameStart = cursor + 8
    let nameEnd = nameStart
    while (nameEnd < metadata.length && nameEnd - nameStart < 32 && metadata[nameEnd] !== 0) nameEnd += 1
    if (nameEnd === metadata.length || nameEnd - nameStart === 32) throw new Error("CLI metadata stream name is invalid")
    const name = metadata.toString("ascii", nameStart, nameEnd)
    cursor = (nameEnd + 4) & ~3
    checkedRange(metadata, offset, size)
    if (streams.has(name)) throw new Error("CLI metadata has duplicate streams")
    streams.set(name, metadata.subarray(offset, offset + size))
  }

  const tables = streams.get("#~") ?? streams.get("#-")
  const strings = streams.get("#Strings")
  if (!tables || !strings) throw new Error("CLI metadata is missing required streams")
  return { tables, strings }
}

function tableIndexSize(rows: readonly number[], table: number): number {
  return (rows[table] ?? 0) < 0x10000 ? 2 : 4
}

function codedIndexSize(rows: readonly number[], name: string): number {
  const coded = CODED_INDICES[name]
  if (!coded) throw new Error("Unknown CLI coded index")
  const maxRows = Math.max(0, ...coded.tables.map((table) => rows[table] ?? 0))
  return maxRows < 2 ** (16 - coded.bits) ? 2 : 4
}

function columnSize(column: Column, rows: readonly number[], heapSizes: number): number {
  if (column === "u16") return 2
  if (column === "u32") return 4
  if (column === "string") return heapSizes & 1 ? 4 : 2
  if (column === "guid") return heapSizes & 2 ? 4 : 2
  if (column === "blob") return heapSizes & 4 ? 4 : 2
  if (column.startsWith("table:")) return tableIndexSize(rows, Number(column.slice(6)))
  return codedIndexSize(rows, column.slice(6))
}

function tableColumns(table: number, rows: readonly number[]): readonly Column[] {
  if (table === 2) {
    return ["u32", "string", "string", "coded:TypeDefOrRef", `table:${rows[3] ? 3 : 4}`, `table:${rows[5] ? 5 : 6}`]
  }
  if (table === 18) return ["table:2", `table:${rows[19] ? 19 : 20}`]
  if (table === 21) return ["table:2", `table:${rows[22] ? 22 : 23}`]
  const columns = TABLES[table]
  if (!columns) throw new Error("Unsupported CLI metadata table")
  return columns
}

function readString(strings: Buffer, index: number): string {
  if (index === 0) return ""
  checkedRange(strings, index, 1)
  const end = strings.subarray(index, index + 1025).indexOf(0)
  const absoluteEnd = index + end
  if (end < 0) throw new Error("CLI assembly name is unterminated or exceeds 1024 bytes")
  return strings.toString("utf8", index, absoluteEnd)
}

function isOptimumAssemblyName(name: string): boolean {
  return /^Optimum\.[a-z0-9_.-]+$/i.test(name)
}

function readReferences(tables: Buffer, strings: Buffer, referenceCount: number, cursor: number, heapSizes: number): string[] {
  if (referenceCount === 0) return []
  const blobWidth = heapSizes & 4 ? 4 : 2
  const stringWidth = heapSizes & 1 ? 4 : 2
  const rowSize = 12 + blobWidth + stringWidth * 2 + blobWidth
  const nameOffset = 12 + blobWidth
  const found = new Map<string, string>()

  for (let index = 0; index < referenceCount; index += 1) {
    const row = cursor + index * rowSize
    checkedRange(tables, row, rowSize)
    const nameIndex = stringWidth === 2 ? readU16(tables, row + nameOffset) : readU32(tables, row + nameOffset)
    const name = readString(strings, nameIndex)
    if (isOptimumAssemblyName(name)) found.set(name.toLowerCase(), `${name}.dll`)
  }
  return Array.from(found.values())
}

/** Returns referenced Optimum assembly filenames, or `undefined` for an invalid/non-managed image. */
export function readOptimumAssemblyReferences(image: Buffer): string[] | undefined {
  try {
    const { tables, strings } = readStreamMetadata(readMetadata(image))
    const valid = tables.readBigUInt64LE(8)
    const heapSizes = tables[6] ?? 0
    const rows: number[] = Array.from({ length: 64 }, () => 0)
    let cursor = 24

    for (let table = 0; table < 64; table += 1) {
      if ((valid & (1n << BigInt(table))) === 0n) continue
      rows[table] = readU32(tables, cursor)
      cursor += 4
    }
    if ((valid & (1n << 32n)) === 0n || rows[32] === 0) return undefined

    for (let table = 0; table < 35; table += 1) {
      const count = rows[table] ?? 0
      if (count === 0) continue
      const rowSize = tableColumns(table, rows).reduce((size, column) => size + columnSize(column, rows, heapSizes), 0)
      cursor += rowSize * count
      checkedRange(tables, cursor, 0)
    }

    return readReferences(tables, strings, rows[35] ?? 0, cursor, heapSizes)
  } catch {
    return undefined
  }
}
