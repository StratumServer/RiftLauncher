/**
 * src/domain/inno/script.ts against hand-built header blocks, rather than
 * whole installer files: readSetupScript takes the two DECOMPRESSED blocks
 * directly, so a table, a version switch, or a corruption check can be
 * exercised on its own without a loader, a CRC-wrapped block or a data area
 * around it.
 *
 * The blocks come from tests/fixtures/build-inno-fixtures.ts's own builders
 * (buildPrimaryBlock, buildSecondaryBlock), extended with every table script.ts
 * crosses so a fixture can actually populate them instead of only ever
 * declaring their count as zero.
 */
import { describe, expect, it } from "vitest"

import { NO_LOCATION, readSetupScript } from "@domain/inno/script"
import { InnoFormatError } from "@domain/inno/errors"

import { buildPrimaryBlock, buildSecondaryBlock, parseVersion, type InstallerSpec } from "../../fixtures/build-inno-fixtures"

function blocksFor(spec: InstallerSpec): { primary: Buffer; secondary: Buffer } {
  return { primary: buildPrimaryBlock(spec), secondary: buildSecondaryBlock(spec) }
}

const ONE_FILE: InstallerSpec["files"] = [{ destination: "{app}\\a.exe", contents: Buffer.from("hi\n") }]

describe("readSetupScript: every table the primary block can carry", () => {
  it("crosses a header where every table holds at least one record", () => {
    const spec: InstallerSpec = {
      version: "6.4.3",
      files: ONE_FILE,
      languages: 2,
      messages: 2,
      permissions: 2,
      types: 2,
      components: 2,
      tasks: 2,
      directories: 2,
      icons: 2,
      iniEntries: 2,
      registryEntries: 2,
      deleteEntries: 2,
      uninstallDeleteEntries: 2,
      runEntries: 2,
      uninstallRunEntries: 2,
      wizardImages: 2,
      wizardSmallImages: 2
    }
    const { primary, secondary } = blocksFor(spec)

    const script = readSetupScript(parseVersion(spec.version), primary, secondary)

    expect(script.files).toHaveLength(1)
    expect(script.files[0]!.destination).toBe("{app}\\a.exe")
    expect(script.dataEntries).toHaveLength(1)
  })

  it("crosses a header with several files and several data entries", () => {
    const spec: InstallerSpec = {
      version: "6.4.3",
      files: [
        { destination: "{app}\\a.exe", contents: Buffer.from("a\n") },
        { destination: "{app}\\b.exe", contents: Buffer.from("bb\n") },
        { destination: "{app}\\c.exe", contents: Buffer.from("ccc\n") }
      ]
    }
    const { primary, secondary } = blocksFor(spec)
    const script = readSetupScript(parseVersion(spec.version), primary, secondary)

    expect(script.files.map((f) => f.destination)).toEqual(["{app}\\a.exe", "{app}\\b.exe", "{app}\\c.exe"])
    expect(script.dataEntries).toHaveLength(3)
  })

  it("reads a file Setup builds itself, with no location of its own", () => {
    const spec: InstallerSpec = {
      version: "6.4.3",
      files: [{ destination: "{app}\\generated.ini" }]
    }
    const { primary, secondary } = blocksFor(spec)
    const script = readSetupScript(parseVersion(spec.version), primary, secondary)

    expect(script.files[0]!.location).toBe(NO_LOCATION)
    expect(script.dataEntries).toHaveLength(0)
  })
})

describe("readSetupScript: version switches", () => {
  it("reads 6.4.0's layout: old wizard colours, no CloseApplicationsFilterExcludes, old location record", () => {
    const spec: InstallerSpec = { version: "6.4.0", files: ONE_FILE }
    const { primary, secondary } = blocksFor(spec)
    const script = readSetupScript(parseVersion(spec.version), primary, secondary)

    expect(script.files).toHaveLength(1)
    expect(script.dataEntries).toHaveLength(1)
  })

  it("reads 6.4.2's layout: flat wizard colours, CloseApplicationsFilterExcludes present, still the old location record", () => {
    const spec: InstallerSpec = { version: "6.4.2", files: ONE_FILE }
    const { primary, secondary } = blocksFor(spec)
    const script = readSetupScript(parseVersion(spec.version), primary, secondary)

    expect(script.files).toHaveLength(1)
    expect(script.dataEntries).toHaveLength(1)
  })

  it("reads 6.4.3's layout: the compact location record", () => {
    const spec: InstallerSpec = { version: "6.4.3", files: ONE_FILE }
    const { primary, secondary } = blocksFor(spec)
    const script = readSetupScript(parseVersion(spec.version), primary, secondary)

    expect(script.files).toHaveLength(1)
    expect(script.dataEntries).toHaveLength(1)
  })

  it("refuses a 6.4.2 header read as though it were 6.4.3, and vice versa", () => {
    const asNewer = buildPrimaryBlock({ version: "6.4.2", files: ONE_FILE })
    const secondaryAsNewer = buildSecondaryBlock({ version: "6.4.2", files: ONE_FILE })
    expect(() => readSetupScript(parseVersion("6.4.3"), asNewer, secondaryAsNewer)).toThrow(InnoFormatError)

    const asOlder = buildPrimaryBlock({ version: "6.4.3", files: ONE_FILE })
    const secondaryAsOlder = buildSecondaryBlock({ version: "6.4.3", files: ONE_FILE })
    expect(() => readSetupScript(parseVersion("6.4.2"), asOlder, secondaryAsOlder)).toThrow(InnoFormatError)
  })
})

describe("readSetupScript: the location record's flags, both layouts", () => {
  it("reads callInstructionOptimized, encrypted and compressed off the compact (6.4.3) record", () => {
    const spec: InstallerSpec = {
      version: "6.4.3",
      dataEntries: [
        { contents: Buffer.from("a\n"), callInstructionOptimized: true },
        { contents: Buffer.from("b\n"), encrypted: true },
        { contents: Buffer.from("c\n"), compressed: true }
      ],
      files: [
        { destination: "{app}\\a.bin", location: 0 },
        { destination: "{app}\\b.bin", location: 1 },
        { destination: "{app}\\c.bin", location: 2 }
      ]
    }
    const { primary, secondary } = blocksFor(spec)
    const script = readSetupScript(parseVersion(spec.version), primary, secondary)

    expect(script.dataEntries[0]).toMatchObject({ callInstructionOptimized: true, encrypted: false, compressed: false })
    expect(script.dataEntries[1]).toMatchObject({ callInstructionOptimized: false, encrypted: true, compressed: false })
    expect(script.dataEntries[2]).toMatchObject({ callInstructionOptimized: false, encrypted: false, compressed: true })
  })

  it("reads the same three flags off the old (pre-6.4.3) record, at their different bit positions", () => {
    const spec: InstallerSpec = {
      version: "6.4.2",
      dataEntries: [
        { contents: Buffer.from("a\n"), callInstructionOptimized: true },
        { contents: Buffer.from("b\n"), encrypted: true },
        { contents: Buffer.from("c\n"), compressed: true }
      ],
      files: [
        { destination: "{app}\\a.bin", location: 0 },
        { destination: "{app}\\b.bin", location: 1 },
        { destination: "{app}\\c.bin", location: 2 }
      ]
    }
    const { primary, secondary } = blocksFor(spec)
    const script = readSetupScript(parseVersion(spec.version), primary, secondary)

    expect(script.dataEntries[0]).toMatchObject({ callInstructionOptimized: true, encrypted: false, compressed: false })
    expect(script.dataEntries[1]).toMatchObject({ callInstructionOptimized: false, encrypted: true, compressed: false })
    expect(script.dataEntries[2]).toMatchObject({ callInstructionOptimized: false, encrypted: false, compressed: true })
  })
})

describe("readSetupScript: compression byte", () => {
  it("reads the zlib and bzip2 bytes, crossing their embedded decompression library string", () => {
    const zlib = blocksFor({ version: "6.4.3", files: ONE_FILE, compression: "zlib" })
    expect(readSetupScript(parseVersion("6.4.3"), zlib.primary, zlib.secondary).compression).toBe("zlib")

    const bzip2 = blocksFor({ version: "6.4.3", files: ONE_FILE, compression: "bzip2" })
    expect(readSetupScript(parseVersion("6.4.3"), bzip2.primary, bzip2.secondary).compression).toBe("bzip2")
  })

  it("reads the lzma1 and lzma2 bytes, which carry no embedded library string", () => {
    const lzma1 = blocksFor({ version: "6.4.3", files: ONE_FILE, compression: "lzma1" })
    expect(readSetupScript(parseVersion("6.4.3"), lzma1.primary, lzma1.secondary).compression).toBe("lzma1")

    const lzma2 = blocksFor({ version: "6.4.3", files: ONE_FILE, compression: "lzma2" })
    expect(readSetupScript(parseVersion("6.4.3"), lzma2.primary, lzma2.secondary).compression).toBe("lzma2")
  })

  it("refuses a compression byte naming nothing the format defines", () => {
    const { primary, secondary } = blocksFor({ version: "6.4.3", files: ONE_FILE, compressionByte: 9 })
    expect(() => readSetupScript(parseVersion("6.4.3"), primary, secondary)).toThrow(/unknown compression method \(9\)/)
  })
})

describe("readSetupScript: end of block corruption", () => {
  it("refuses a main header block with bytes left over past every table", () => {
    const primary = Buffer.concat([buildPrimaryBlock({ version: "6.4.3", files: ONE_FILE }), Buffer.from([0xaa])])
    const secondary = buildSecondaryBlock({ version: "6.4.3", files: ONE_FILE })
    expect(() => readSetupScript(parseVersion("6.4.3"), primary, secondary)).toThrow(/unexpected bytes at the end of the main header block/)
  })

  it("refuses a location block with bytes left over past every record", () => {
    const primary = buildPrimaryBlock({ version: "6.4.3", files: ONE_FILE })
    const secondary = Buffer.concat([buildSecondaryBlock({ version: "6.4.3", files: ONE_FILE }), Buffer.from([0xaa])])
    expect(() => readSetupScript(parseVersion("6.4.3"), primary, secondary)).toThrow(/unexpected bytes at the end of the location block/)
  })
})
