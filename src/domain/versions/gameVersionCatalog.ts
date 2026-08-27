/**
 * The public game version catalogs.
 *
 * Official API: https://api.vintagestory.at/{stable,unstable}.json
 * Shape: { [version]: { [platform]: { filename, filesize, md5, urls: { cdn, local }, ... } } }
 */

/** Where one build is downloaded from, tolerant of every field beyond the one the installer reads. */
export interface RawPlatformUrls extends Record<string, unknown> {
  cdn: string
}

/** One platform's build as the catalog publishes it. */
export interface RawPlatform extends Record<string, unknown> {
  filename?: string
  urls: RawPlatformUrls
}

/** One catalog row: the builds published for one version, plus anything else that version carries. */
export interface RawVersion extends Record<string, unknown> {
  windows?: RawPlatform
  linux?: RawPlatform
  "mac-arm64"?: RawPlatform
  "mac-x64"?: RawPlatform
}

export type RawVersions = Record<string, RawVersion>

/** The four keys the install picker reads. Any other key on a row is carried through unchecked. */
const PLATFORM_KEYS = new Set(["windows", "linux", "mac-arm64", "mac-x64"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Reads one platform's build.
 *
 * `urls.cdn` is the string handed to the downloader and `filename` the name the file is saved
 * under, so both are checked for the type the caller already assumes rather than trusted. A build
 * that fails either check answers undefined, and the row keeps everything else it carried.
 */
function readPlatform(value: unknown): RawPlatform | undefined {
  if (!isRecord(value)) return undefined

  const { filename, urls } = value
  if (filename !== undefined && typeof filename !== "string") return undefined
  if (!isRecord(urls)) return undefined

  const cdn = urls["cdn"]
  if (typeof cdn !== "string") return undefined

  return { ...value, filename, urls: { ...urls, cdn } }
}

function readVersion(value: unknown): RawVersion | undefined {
  if (!isRecord(value)) return undefined

  const version: RawVersion = {}

  for (const [key, entry] of Object.entries(value)) {
    if (!PLATFORM_KEYS.has(key)) {
      version[key] = entry
      continue
    }

    const platform = readPlatform(entry)
    if (platform !== undefined) version[key] = platform
  }

  return version
}

/**
 * Reads one catalog the version API serves.
 *
 * Total: text that is not JSON, or JSON that is not an object of versions, answers with an empty
 * catalog rather than throwing, and the hook already treats two empty catalogs as the failure it
 * shows a retry for. Rows are checked one at a time, and a build the installer cannot use is
 * dropped from its version instead of taking the version with it, so one bad entry upstream costs
 * that entry and not the fifty good versions beside it.
 */
export function parseGameVersionCatalog(text: string): RawVersions {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }

  if (!isRecord(parsed)) return {}

  const catalog: RawVersions = {}

  for (const [version, entry] of Object.entries(parsed)) {
    const row = readVersion(entry)
    if (row !== undefined) catalog[version] = row
  }

  return catalog
}
