/**
 * The small pieces the installer reader is built out of: the checksum, the
 * version string, the record cursor, the path rule and the executable filter.
 *
 * They are tested apart from the extractor because each one is a refusal the
 * whole read depends on, and a refusal that only shows up through a whole
 * installer is one nobody can see the shape of.
 */
import { describe, expect, it } from "vitest"

import { undoCallInstructionFilter } from "@domain/inno/callFilter"
import { crc32 } from "@domain/inno/crc32"
import { InnoFormatError, isInnoFormatError } from "@domain/inno/errors"
import { relativeAppPath, safeRelativePath } from "@domain/inno/paths"
import { InnoRecordReader } from "@domain/inno/records"
import { formatVersion, hasCloseApplicationsFilterExcludes, hasCompactFileLocationRecord, headerFlagCount, parseInnoSetupVersion, requireSupportedVersion } from "@domain/inno/version"

function identification(text: string): Uint8Array {
  const id = new Uint8Array(64)
  for (let i = 0; i < text.length; i++) id[i] = text.charCodeAt(i)
  return id
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926)
  })

  it("is zero over nothing", () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it("checksums a range rather than the whole buffer", () => {
    const padded = new Uint8Array([0xff, 0xff, ...new TextEncoder().encode("123456789"), 0xff])
    expect(crc32(padded, 2, 11)).toBe(0xcbf43926)
  })
})

describe("parseInnoSetupVersion", () => {
  it("reads the three and four digit forms", () => {
    expect(parseInnoSetupVersion(identification("Inno Setup Setup Data (6.4.3)"))).toEqual({ major: 6, minor: 4, patch: 3, revision: 0 })
    expect(parseInnoSetupVersion(identification("Inno Setup Setup Data (6.4.0.1)"))).toEqual({ major: 6, minor: 4, patch: 0, revision: 1 })
  })

  it("reads nothing out of a block that is not an identification string", () => {
    expect(parseInnoSetupVersion(identification("Inno Setup Setup Data (six.four)"))).toBeUndefined()
    expect(parseInnoSetupVersion(identification("Some Other Installer (6.4.3)"))).toBeUndefined()
    expect(parseInnoSetupVersion(identification("Inno Setup Setup Data (6.4.3"))).toBeUndefined()
    expect(parseInnoSetupVersion(new Uint8Array(4))).toBeUndefined()
  })

  it("refuses a run of five numbers, which no version has", () => {
    expect(parseInnoSetupVersion(identification("Inno Setup Setup Data (6.4.3.1.2)"))).toBeUndefined()
  })
})

describe("requireSupportedVersion", () => {
  it("accepts the 6.4 family", () => {
    expect(formatVersion(requireSupportedVersion(identification("Inno Setup Setup Data (6.4.3)")))).toBe("6.4.3")
  })

  it("refuses a family whose layout it does not know", () => {
    expect(() => requireSupportedVersion(identification("Inno Setup Setup Data (6.5.0)"))).toThrow(/setup data format 6.5.0/)
    expect(() => requireSupportedVersion(identification("Inno Setup Setup Data (5.6.1)"))).toThrow(InnoFormatError)
  })

  it("refuses a block holding no identification string", () => {
    expect(() => requireSupportedVersion(new Uint8Array(64))).toThrow(/no Inno Setup identification string/)
  })
})

describe("version switches", () => {
  it("turns on the extra header string from 6.4.2", () => {
    expect(hasCloseApplicationsFilterExcludes({ major: 6, minor: 4, patch: 1, revision: 0 })).toBe(false)
    expect(hasCloseApplicationsFilterExcludes({ major: 6, minor: 4, patch: 2, revision: 0 })).toBe(true)
  })

  it("turns on the slim location record from 6.4.3", () => {
    expect(hasCompactFileLocationRecord({ major: 6, minor: 4, patch: 2, revision: 0 })).toBe(false)
    expect(hasCompactFileLocationRecord({ major: 6, minor: 4, patch: 3, revision: 0 })).toBe(true)
  })

  it("drops five header flags once the wizard colours went, at 6.4.0.1", () => {
    expect(headerFlagCount({ major: 6, minor: 4, patch: 0, revision: 0 })).toBe(49)
    expect(headerFlagCount({ major: 6, minor: 4, patch: 0, revision: 1 })).toBe(44)
  })
})

describe("InnoRecordReader", () => {
  it("reads the integers and strings the format stores", () => {
    const text = Buffer.from("ab", "utf16le")
    const bytes = Buffer.concat([Buffer.from([0x2a]), Buffer.from([0x01, 0x00, 0x00, 0x00]), Buffer.from([0x04, 0x00, 0x00, 0x00]), text])
    const reader = new InnoRecordReader(new Uint8Array(bytes))

    expect(reader.readByte()).toBe(0x2a)
    expect(reader.readUInt32()).toBe(1)
    expect(reader.readString()).toBe("ab")
    expect(reader.remaining).toBe(0)
  })

  it("keeps supplementary Unicode characters intact in UTF-16 strings", () => {
    const text = Buffer.from("hello 😀", "utf16le")
    const bytes = Buffer.concat([Buffer.from([text.length, 0, 0, 0]), text])
    const reader = new InnoRecordReader(new Uint8Array(bytes))

    expect(reader.readString()).toBe("hello 😀")
  })

  it("throws rather than returning zeroes past the end of the block", () => {
    const reader = new InnoRecordReader(new Uint8Array(2))
    expect(() => reader.read(3)).toThrow(/left only 2 in the block/)
  })

  it("refuses a count that could only come from a shifted read", () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0x7f])
    expect(() => new InnoRecordReader(bytes).readCount()).toThrow(/implausible entry count/)
  })

  it("refuses a 64 bit field past what can be counted exactly", () => {
    const bytes = new Uint8Array([0, 0, 0, 0, 0, 0, 0xff, 0xff])
    expect(() => new InnoRecordReader(bytes).readUInt64()).toThrow(/counted exactly/)
  })

  it("refuses a UTF-16 string of odd length", () => {
    const bytes = new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x61, 0x00, 0x62])
    expect(() => new InnoRecordReader(bytes).readString()).toThrow(/odd number of bytes/)
  })

  it("pads a three byte flag set out to four, as the format does", () => {
    const bytes = new Uint8Array([0x05, 0x00, 0x00, 0x00, 0xaa])
    const reader = new InnoRecordReader(bytes)
    expect(reader.readFlags(24)).toBe(5)
    expect(reader.readByte()).toBe(0xaa)
  })
})

describe("relativeAppPath", () => {
  it("keeps what is destined for the version folder", () => {
    expect(relativeAppPath("{app}\\Vintagestory.exe")).toBe("Vintagestory.exe")
    expect(relativeAppPath("{APP}\\assets\\a.txt")).toBe("assets\\a.txt")
  })

  it("drops what is destined anywhere else", () => {
    expect(relativeAppPath("{fonts}\\Lora.ttf")).toBeUndefined()
    expect(relativeAppPath("{app}\\")).toBeUndefined()
    expect(relativeAppPath("{app}")).toBeUndefined()
  })
})

describe("safeRelativePath", () => {
  it("turns a stored path into one shape", () => {
    expect(safeRelativePath("assets\\game\\a.txt")).toBe("assets/game/a.txt")
    expect(safeRelativePath("assets\\.\\a.txt")).toBe("assets/a.txt")
    expect(safeRelativePath("assets\\\\a.txt")).toBe("assets/a.txt")
  })

  it("refuses anything that could be written outside the folder", () => {
    expect(safeRelativePath("..\\escaped.txt")).toBeUndefined()
    expect(safeRelativePath("assets\\..\\..\\escaped.txt")).toBeUndefined()
    expect(safeRelativePath("\\absolute.txt")).toBeUndefined()
    expect(safeRelativePath("/absolute.txt")).toBeUndefined()
    expect(safeRelativePath("C:\\windows\\system32\\a.dll")).toBeUndefined()
    expect(safeRelativePath("a.txt:stream")).toBeUndefined()
  })

  it("refuses a name holding a control byte", () => {
    expect(safeRelativePath(`a${String.fromCharCode(0)}b.txt`)).toBeUndefined()
    expect(safeRelativePath(`a${String.fromCharCode(0x7f)}b.txt`)).toBeUndefined()
  })

  it("refuses a path that names nothing", () => {
    expect(safeRelativePath("")).toBeUndefined()
    expect(safeRelativePath(".")).toBeUndefined()
  })
})

describe("undoCallInstructionFilter", () => {
  it("turns an absolute address back into the relative one", () => {
    // A CALL at offset 0 addresses the instruction after it, so an absolute
    // address of 5 means a relative displacement of zero.
    const data = new Uint8Array([0xe8, 0x05, 0x00, 0x00, 0x00])
    undoCallInstructionFilter(data)
    expect([...data]).toEqual([0xe8, 0x00, 0x00, 0x00, 0x00])
  })

  it("leaves alone the bytes that were never transformed", () => {
    // A high byte that is neither 0x00 nor 0xFF was left as it was by the
    // compiler, so it stays as it is here too.
    const data = new Uint8Array([0xe8, 0x05, 0x00, 0x00, 0x42])
    undoCallInstructionFilter(data)
    expect([...data]).toEqual([0xe8, 0x05, 0x00, 0x00, 0x42])
  })

  it("never reads an address byte as another instruction", () => {
    // The 0xE8 inside the first instruction's address is an address byte, not
    // an opcode. Rescanning it would shift everything after it.
    const data = new Uint8Array([0xe8, 0xe8, 0x00, 0x00, 0x00, 0x11, 0x22])
    undoCallInstructionFilter(data)
    expect(data[5]).toBe(0x11)
    expect(data[6]).toBe(0x22)
  })

  it("leaves an instruction straddling a block boundary alone", () => {
    const data = new Uint8Array(0x10000 + 8)
    data[0x10000 - 3] = 0xe8
    data[0x10000 - 2] = 0x05
    undoCallInstructionFilter(data)
    expect(data[0x10000 - 2]).toBe(0x05)
  })
})

describe("isInnoFormatError", () => {
  it("tells the reader's refusals apart from anything else", () => {
    expect(isInnoFormatError(InnoFormatError.unsupported("a format"))).toBe(true)
    expect(isInnoFormatError(InnoFormatError.corrupt("a checksum"))).toBe(true)
    expect(isInnoFormatError(new Error("something else"))).toBe(false)
    expect(isInnoFormatError(undefined)).toBe(false)
  })

  it("carries which of the two refusals it is", () => {
    expect(InnoFormatError.unsupported("a format").reason).toBe("unsupported")
    expect(InnoFormatError.corrupt("a checksum").reason).toBe("corrupt")
  })
})
