/**
 * The version of an Inno Setup installer's DATA FORMAT, read from the
 * `Inno Setup Setup Data (x.y.z)` string that sits in front of the compressed
 * header.
 *
 * This is not the compiler's version number. It moves only when the binary
 * layout of the records changes, which makes it exactly the key a reader needs:
 * two different compilers that write the same string write the same layout.
 *
 * Only the 6.4 family is read, which is what Vintage Story publishes today. Two
 * switches cover the whole family, both of them visible in the Inno Setup
 * sources (`Projects/Src/Shared.Struct.pas`):
 *
 * - 6.4.2 adds the `CloseApplicationsFilterExcludes` directive, so one more
 *   string in the header, right after the architecture expressions.
 * - 6.4.3 slims the file location record: the `Sign` byte goes away and the flag
 *   set drops from nine members to five RENUMBERED ones, taking the record from
 *   87 bytes to 85.
 *
 * Anything outside the family is refused rather than guessed at. A 6.5 header is
 * reorganised in earnest, and reading it with the 6.4 layout would not produce a
 * clean error but plausible looking nonsense for every path and every size.
 */
import { InnoFormatError } from "./errors"

/** The ASCII prefix of the identification string, as written in the file. */
export const ID_PREFIX = "Inno Setup Setup Data ("

/** Length of the identification block, zero padding included. */
export const ID_LENGTH = 64

export interface InnoSetupVersion {
  major: number
  minor: number
  patch: number
  /** Fourth digit, present only on some releases such as `6.4.0.1`. */
  revision: number
}

/** True for the versions whose layout this reader claims to know. */
export function isSupportedVersion(version: InnoSetupVersion): boolean {
  return version.major === 6 && version.minor === 4
}

function compare(version: InnoSetupVersion, major: number, minor: number, patch: number, revision: number): number {
  if (version.major !== major) return version.major - major
  if (version.minor !== minor) return version.minor - minor
  if (version.patch !== patch) return version.patch - patch
  return version.revision - revision
}

/** True when the header carries the `CloseApplicationsFilterExcludes` string (6.4.2 and up). */
export function hasCloseApplicationsFilterExcludes(version: InnoSetupVersion): boolean {
  return compare(version, 6, 4, 2, 0) >= 0
}

/** True when the file location record is the slim 6.4.3 one: five flags in a byte, and no `Sign`. */
export function hasCompactFileLocationRecord(version: InnoSetupVersion): boolean {
  return compare(version, 6, 4, 3, 0) >= 0
}

/**
 * True once the wizard lost its background colours and window flags, which Inno
 * Setup 6.4.0.1 removed. Two fewer fields in the header, and five fewer flags in
 * its option set.
 */
export function hasFlatWizardColours(version: InnoSetupVersion): boolean {
  return compare(version, 6, 4, 0, 1) >= 0
}

/**
 * How many option flags the header declares.
 *
 * The count is never used to interpret the flags, only to know HOW MANY BYTES
 * they take. They are the last field of the block, so being one byte out is
 * caught by the end of block check rather than by anything sooner.
 */
export function headerFlagCount(version: InnoSetupVersion): number {
  return hasFlatWizardColours(version) ? 44 : 49
}

/** Renders a version the way the file spells it, for log lines and errors. */
export function formatVersion(version: InnoSetupVersion): string {
  return version.revision === 0 ? `${version.major}.${version.minor}.${version.patch}` : `${version.major}.${version.minor}.${version.patch}.${version.revision}`
}

/**
 * Splits a run of dot separated numbers, refusing everything else.
 *
 * The refusal is the point. This string is the first check that tells a real
 * header apart from a twelve byte pattern that landed by chance inside a
 * resource, so accepting an approximate shape would let the read start at an
 * arbitrary offset.
 */
function parseNumbers(bytes: Uint8Array): number[] | undefined {
  const parts: number[] = []
  let value = 0
  let digits = 0

  for (const byte of bytes) {
    if (byte >= 0x30 && byte <= 0x39) {
      value = value * 10 + (byte - 0x30)
      digits++
      continue
    }
    if (byte !== 0x2e || digits === 0 || parts.length === 4) return undefined
    parts.push(value)
    value = 0
    digits = 0
  }

  if (digits === 0 || parts.length === 4) return undefined
  parts.push(value)
  return parts
}

/**
 * Reads the identification string.
 *
 * @param id The {@link ID_LENGTH} bytes found where the header is announced.
 * @returns The version, or undefined when the block is not an identification
 * string at all.
 */
export function parseInnoSetupVersion(id: Uint8Array): InnoSetupVersion | undefined {
  if (id.length < ID_PREFIX.length + 2) return undefined
  for (let i = 0; i < ID_PREFIX.length; i++) if (id[i] !== ID_PREFIX.charCodeAt(i)) return undefined

  const rest = id.subarray(ID_PREFIX.length)
  const end = rest.indexOf(0x29)
  if (end <= 0) return undefined

  const parts = parseNumbers(rest.subarray(0, end))
  if (!parts) return undefined

  return { major: parts[0]!, minor: parts[1] ?? 0, patch: parts[2] ?? 0, revision: parts[3] ?? 0 }
}

/** Reads the identification string and refuses anything this reader will not follow. */
export function requireSupportedVersion(id: Uint8Array): InnoSetupVersion {
  const version = parseInnoSetupVersion(id)
  if (!version) throw InnoFormatError.corrupt("no Inno Setup identification string where the loader announced one")
  if (!isSupportedVersion(version)) throw InnoFormatError.unsupported(`setup data format ${formatVersion(version)}`)
  return version
}
