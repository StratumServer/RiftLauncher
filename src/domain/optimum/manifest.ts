/**
 * Optimum's overlay manifest, as published beside the archive it describes.
 *
 * Shape (Optimum.Bootstrap.Core/Patch/PatchManifest.cs):
 * { manifestVersion, optimumVersion, supportedGameVersions[], rid,
 *   archive: { filename, size, sha256 }, targets[], files[] }
 *
 * Read the same way `parseGameVersionCatalog` reads the game catalog: total,
 * and one bad entry costs that entry rather than the whole document. The
 * difference is what a bad *header* costs. The catalog is a list the player
 * picks from, so a broken row is a row fewer; this manifest is the only thing
 * standing between a downloaded archive and a child process, so anything wrong
 * with the version, the platform, the archive name, or its hash answers
 * undefined and no Optimum is offered at all.
 *
 * Two fields the wire carries are deliberately not read. `targets[]` keeps
 * `expectedInputSha256` and `expectedOutputSha256` in its record type and the
 * packaging script never writes either, so treating them as absent is not a
 * simplification, it is what they are. Reading them would invite a check that
 * silently passes on every real manifest.
 */

import semver from "semver"

/** The platforms an overlay is published for. A label on the wire, a closed set here. */
export const OPTIMUM_RIDS = ["linux-x64", "win-x64"] as const

export type OptimumRid = (typeof OPTIMUM_RIDS)[number]

/**
 * Ceiling on the overlay archive, and on any single file staged out of it.
 *
 * The real archive is tens of megabytes: four donor assemblies, the patcher,
 * the CLI, the shaders and the language files. 512 MiB is an order of magnitude
 * of headroom and still refuses a manifest claiming something the size of a
 * game build.
 */
export const MAX_OPTIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024

/** Ceiling on how many files a manifest may describe, so a hostile document cannot make the verification pass unbounded. */
const MAX_OPTIMUM_FILES = 10_000

/** `sha256:` followed by lowercase hex, which is how every hash in the document is spelled. */
const SHA256_FIELD = /^sha256:([a-f0-9]{64})$/

export interface OptimumArchive {
  /** Archive file name, which is also the name it is saved under and the stem of the folder inside it. */
  filename: string
  size: number
  /** Bare lowercase hex, prefix stripped. */
  sha256: string
}

/** One staged file, as the packaging walk recorded it. */
export interface OptimumFile {
  /** Relative, forward slashes, no `..` segment and no leading slash. */
  path: string
  size: number
  /** Bare lowercase hex, prefix stripped. */
  sha256: string
}

/** One assembly the patch rewrites, and the donor it rewrites it from. */
export interface OptimumTarget {
  assembly: string
  donor: string
  mode: string
  modName?: string
}

export interface OptimumManifest {
  manifestVersion: 1
  optimumVersion: string
  supportedGameVersions: string[]
  rid: OptimumRid
  archive: OptimumArchive
  targets: OptimumTarget[]
  files: OptimumFile[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The bare hex of a `sha256:`-prefixed field, or undefined when it is not one. */
function readHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return SHA256_FIELD.exec(value)?.[1]
}

function readSize(value: unknown, allowZero: boolean): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value > MAX_OPTIMUM_ARCHIVE_BYTES) return undefined
  if (allowZero ? value < 0 : value <= 0) return undefined
  return value
}

function isRid(value: unknown): value is OptimumRid {
  return typeof value === "string" && (OPTIMUM_RIDS as readonly string[]).includes(value)
}

/** The one name an overlay archive may carry, built from the two fields that were already checked. */
export function expectedArchiveName(optimumVersion: string, rid: OptimumRid): string {
  return `Optimum-v${optimumVersion}-${rid}-overlay.tar.gz`
}

function readArchive(value: unknown, optimumVersion: string, rid: OptimumRid): OptimumArchive | undefined {
  if (!isRecord(value)) return undefined

  const { filename } = value
  // Compared against the name the launcher builds rather than matched with a
  // pattern: the version and the platform are the two things that decide which
  // payload is about to run, and building the name is the only way the check
  // cannot drift from what the download URL is built out of.
  if (typeof filename !== "string" || filename !== expectedArchiveName(optimumVersion, rid)) return undefined

  const size = readSize(value.size, false)
  const sha256 = readHash(value.sha256)
  if (size === undefined || sha256 === undefined) return undefined

  return { filename, size, sha256 }
}

/** True when a path is relative, forward-slashed, and stays inside the folder it is read against. */
export function isSafeOverlayPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || value.includes("\0") || value.includes("\\")) return false
  if (value.startsWith("/")) return false
  const segments = value.split("/")
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

function readFile(value: unknown): OptimumFile | undefined {
  if (!isRecord(value)) return undefined
  const { path } = value
  if (!isSafeOverlayPath(path)) return undefined

  // Zero is allowed here and refused for the archive: an overlay legitimately
  // carries empty files, an archive of no bytes is not an archive.
  const size = readSize(value.size, true)
  const sha256 = readHash(value.sha256)
  if (size === undefined || sha256 === undefined) return undefined

  return { path, size, sha256 }
}

function readTarget(value: unknown): OptimumTarget | undefined {
  if (!isRecord(value)) return undefined
  const { assembly, donor, mode, modName } = value
  if (!isSafeOverlayPath(assembly) || !isSafeOverlayPath(donor)) return undefined
  if (typeof mode !== "string" || mode.length === 0 || mode.length > 64) return undefined
  if (modName !== undefined && (typeof modName !== "string" || modName.length > 128)) return undefined

  return modName === undefined ? { assembly, donor, mode } : { assembly, donor, mode, modName }
}

/**
 * Reads one overlay manifest.
 *
 * @param text The document as it was written to disk.
 * @returns The manifest, or undefined when nothing usable could be read.
 */
export function parseOptimumManifest(text: string): OptimumManifest | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }

  if (!isRecord(parsed)) return undefined
  if (parsed.manifestVersion !== 1) return undefined

  const optimumVersion = typeof parsed.optimumVersion === "string" ? semver.valid(parsed.optimumVersion) : null
  if (!optimumVersion) return undefined

  const { rid } = parsed
  if (!isRid(rid)) return undefined

  const supportedGameVersions = (Array.isArray(parsed.supportedGameVersions) ? parsed.supportedGameVersions : [])
    .map((entry) => (typeof entry === "string" ? semver.valid(entry) : null))
    .filter((entry): entry is string => entry !== null)
  // An overlay that lists no game version it supports supports none: the gate is
  // entirely the launcher's, since the CLI never enforces it.
  if (supportedGameVersions.length === 0) return undefined

  const archive = readArchive(parsed.archive, optimumVersion, rid)
  if (!archive) return undefined

  const targets = (Array.isArray(parsed.targets) ? parsed.targets : []).map(readTarget).filter((target): target is OptimumTarget => target !== undefined)

  const files = (Array.isArray(parsed.files) ? parsed.files : [])
    .map(readFile)
    .filter((file): file is OptimumFile => file !== undefined)
    .slice(0, MAX_OPTIMUM_FILES)
  // Nothing runs unless every staged file was named and hashed here, so a
  // manifest with no file list is a manifest that vouches for nothing.
  if (files.length === 0) return undefined

  return { manifestVersion: 1, optimumVersion, supportedGameVersions, rid, archive, targets, files }
}
