/**
 * Builds the small managed PE image needed by metadata-reader tests.
 *
 * Its user strings heap may contain decoys, but only names in AssemblyRef rows
 * are references. The fixture deliberately writes the PE and CLI metadata
 * headers too, so production parsing is exercised instead of a test-only path.
 */
export function makeManagedAssembly(references: readonly string[], extraStrings: readonly string[] = []): Buffer {
  let stringHeap = Buffer.from([0])
  const stringOffsets = new Map<string, number>()

  function stringIndex(value: string): number {
    const existing = stringOffsets.get(value)
    if (existing !== undefined) return existing
    const index = stringHeap.length
    const encoded = Buffer.from(value, "utf8")
    stringHeap = Buffer.concat([stringHeap, encoded, Buffer.from([0])])
    stringOffsets.set(value, index)
    return index
  }

  for (const value of ["Fixture.dll", "Fixture", ...references, ...extraStrings]) stringIndex(value)
  if (stringHeap.length >= 0x10000) throw new Error("Fixture strings do not fit a 2-byte heap index")

  const validTables = (1n << 0n) | (1n << 32n) | (1n << 35n)
  const tableHeader = Buffer.alloc(24 + 12)
  tableHeader.writeUInt32LE(0, 0)
  tableHeader[4] = 2
  tableHeader[5] = 0
  tableHeader[6] = 0
  tableHeader[7] = 1
  tableHeader.writeBigUInt64LE(validTables, 8)
  tableHeader.writeBigUInt64LE(0n, 16)
  tableHeader.writeUInt32LE(1, 24)
  tableHeader.writeUInt32LE(1, 28)
  tableHeader.writeUInt32LE(references.length, 32)

  const moduleRow = Buffer.alloc(10)
  moduleRow.writeUInt16LE(0, 0)
  moduleRow.writeUInt16LE(stringIndex("Fixture.dll"), 2)
  moduleRow.writeUInt16LE(1, 4)
  const assemblyRow = Buffer.alloc(22)
  assemblyRow.writeUInt32LE(0x8004, 0)
  assemblyRow.writeUInt16LE(1, 4)
  assemblyRow.writeUInt32LE(0, 12)
  assemblyRow.writeUInt16LE(0, 16)
  assemblyRow.writeUInt16LE(stringIndex("Fixture"), 18)
  const referenceRows = references.map((name) => {
    const row = Buffer.alloc(20)
    row.writeUInt16LE(1, 0)
    row.writeUInt32LE(0, 8)
    row.writeUInt16LE(0, 12)
    row.writeUInt16LE(stringIndex(name), 14)
    return row
  })
  const tables = Buffer.concat([tableHeader, moduleRow, assemblyRow, ...referenceRows])
  const guidHeap = Buffer.alloc(16)

  const version = Buffer.from("v4.0.30319\0\0", "ascii")
  const headersLength = 32 + 12 + 20 + 16
  const tablesOffset = headersLength
  const stringsOffset = tablesOffset + tables.length
  const guidOffset = stringsOffset + stringHeap.length
  const tablesHeader = Buffer.alloc(32)
  tablesHeader.writeUInt32LE(0x424a5342, 0)
  tablesHeader.writeUInt16LE(1, 4)
  tablesHeader.writeUInt16LE(1, 6)
  tablesHeader.writeUInt32LE(0, 8)
  tablesHeader.writeUInt32LE(version.length, 12)
  version.copy(tablesHeader, 16)
  tablesHeader.writeUInt16LE(0, 28)
  tablesHeader.writeUInt16LE(3, 30)

  const tablesStreamHeader = Buffer.alloc(12)
  tablesStreamHeader.writeUInt32LE(tablesOffset, 0)
  tablesStreamHeader.writeUInt32LE(tables.length, 4)
  tablesStreamHeader.write("#~\0", 8, "ascii")
  const stringsStreamHeader = Buffer.alloc(20)
  stringsStreamHeader.writeUInt32LE(stringsOffset, 0)
  stringsStreamHeader.writeUInt32LE(stringHeap.length, 4)
  stringsStreamHeader.write("#Strings\0", 8, "ascii")
  const guidStreamHeader = Buffer.alloc(16)
  guidStreamHeader.writeUInt32LE(guidOffset, 0)
  guidStreamHeader.writeUInt32LE(guidHeap.length, 4)
  guidStreamHeader.write("#GUID\0", 8, "ascii")
  const metadata = Buffer.concat([tablesHeader, tablesStreamHeader, stringsStreamHeader, guidStreamHeader, tables, stringHeap, guidHeap])

  const peOffset = 0x80
  const optionalOffset = peOffset + 24
  const sectionOffset = optionalOffset + 0xe0
  const rawOffset = 0x200
  const metadataOffset = rawOffset + 0x80
  const rawSize = 0x1000
  const image = Buffer.alloc(rawOffset + rawSize)
  image.write("MZ", 0, "ascii")
  image.writeUInt32LE(peOffset, 0x3c)
  image.write("PE\0\0", peOffset, "binary")
  image.writeUInt16LE(0x14c, peOffset + 4)
  image.writeUInt16LE(1, peOffset + 6)
  image.writeUInt16LE(0xe0, peOffset + 20)
  image.writeUInt16LE(0x10b, optionalOffset)
  image.writeUInt32LE(16, optionalOffset + 92)
  image.writeUInt32LE(0x2000, optionalOffset + 96 + 14 * 8)
  image.writeUInt32LE(72, optionalOffset + 96 + 14 * 8 + 4)
  image.write(".text", sectionOffset, "ascii")
  image.writeUInt32LE(rawSize, sectionOffset + 8)
  image.writeUInt32LE(0x2000, sectionOffset + 12)
  image.writeUInt32LE(rawSize, sectionOffset + 16)
  image.writeUInt32LE(rawOffset, sectionOffset + 20)
  image.writeUInt32LE(72, rawOffset)
  image.writeUInt32LE(0x2080, rawOffset + 8)
  image.writeUInt32LE(metadata.length, rawOffset + 12)
  metadata.copy(image, metadataOffset)
  return image
}
