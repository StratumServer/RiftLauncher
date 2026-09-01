/**
 * The launcher background, as a catalog the repository serves rather than an asset the
 * installer carries.
 *
 * Three tiers, and the id in the config picks between them:
 *  - {@link DEFAULT_BACKGROUND_ID}: the scene bundled with the app. Always available, no
 *    network, and what a first launch offline shows.
 *  - a catalog id: a scene living on the repository's `backgrounds` branch, downloaded once
 *    into the userData cache the first time the player picks it.
 *  - {@link CUSTOM_BACKGROUND_ID}: the player's own picture, copied into that same cache.
 *
 * Every cached file is named after its id ({@link backgroundCacheFileName}), so the renderer
 * can paint a saved choice at startup knowing nothing but the id. That is the whole reason the
 * manifest's `file` never reaches the config: it is only the name on the branch, and the
 * download renames it on the way in. The manifest may also name a small remote thumbnail for
 * the picker; unlike the full-size scene, it is rendered directly and never cached by the app.
 */

/** The scene shipped inside the app. Selected when nothing else is, and the offline answer. */
export const DEFAULT_BACKGROUND_ID = "default"

/** Reserved for the picture the player supplied. Never a catalog id. */
export const CUSTOM_BACKGROUND_ID = "custom"

const BACKGROUNDS_BRANCH_URL = "https://raw.githubusercontent.com/StratumServer/RiftLauncher/backgrounds/"

/** The catalog itself. Fetched when the settings section is opened, never at startup. */
export const BACKGROUNDS_MANIFEST_URL = `${BACKGROUNDS_BRANCH_URL}manifest.json`

/** Where one catalog scene is downloaded from. `file` comes from the manifest and is validated. */
export function backgroundImageUrl(file: string): string {
  return `${BACKGROUNDS_BRANCH_URL}${file}`
}

/** Where one catalog thumbnail is served from. `thumbnail` comes from the validated manifest. */
export function backgroundThumbnailUrl(thumbnail: string): string {
  return `${BACKGROUNDS_BRANCH_URL}${thumbnail}`
}

/**
 * How many scenes the launcher will read out of one manifest. Well past the eleven the branch
 * carries today, and there so a manifest that grows unnoticed cannot turn the settings page into
 * an unbounded grid.
 */
const MAX_BACKGROUND_ENTRIES = 64

const BACKGROUND_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
const BACKGROUND_FILE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\.jpg$/
const BACKGROUND_THUMBNAIL_PATTERN = /^thumbnails\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\.jpg$/

/** True for the default id, the custom id, and any well-formed catalog slug. */
export function isBackgroundId(value: unknown): value is string {
  return typeof value === "string" && BACKGROUND_ID_PATTERN.test(value)
}

/** True for an id that names a scene on the branch, which the two reserved ids never do. */
export function isCatalogBackgroundId(value: unknown): value is string {
  return isBackgroundId(value) && value !== DEFAULT_BACKGROUND_ID && value !== CUSTOM_BACKGROUND_ID
}

/** True for a file name the manifest is allowed to point at: a plain slug, on the branch, a JPEG. */
export function isBackgroundFileName(value: unknown): value is string {
  return typeof value === "string" && BACKGROUND_FILE_PATTERN.test(value)
}

/** True for a thumbnail path confined to the branch's fixed `thumbnails` directory. */
export function isBackgroundThumbnailFileName(value: unknown): value is string {
  return typeof value === "string" && BACKGROUND_THUMBNAIL_PATTERN.test(value)
}

/**
 * True when these bytes start with the JPEG SOI marker.
 *
 * A name and an extension say nothing about what a file holds, and both the branch and the
 * player's own picker can hand over something else. This is the only claim worth making without a
 * decoder: the file the launcher is about to cache and serve as `image/jpeg` at least begins like
 * one.
 */
export function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** How much of a file has to be read before {@link isPngBytes} can answer. */
export const PNG_SIGNATURE_BYTES = PNG_SIGNATURE.length

/**
 * True when these bytes start with the PNG signature.
 *
 * The sibling of {@link isJpegBytes}, and here for the same reason: the custom installation icon
 * the player picks is checked by extension alone, so a file renamed to `.png` clears every gate on
 * the way into the Icons folder and out again through the `icons:` protocol. Two flows this close
 * together should not disagree about how hard they look (#211).
 */
export function isPngBytes(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

/** Anything that is not a usable id, missing included, becomes the built-in default. */
export function normalizeBackgroundId(value: unknown): string {
  return isBackgroundId(value) ? value : DEFAULT_BACKGROUND_ID
}

/** The name a background is cached under, whatever it was called on the branch. */
export function backgroundCacheFileName(id: string): string {
  return `${id}.jpg`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseEntry(value: unknown): BackgroundType | null {
  if (!isRecord(value)) return null
  const { id, name, file, thumbnail } = value

  if (!isCatalogBackgroundId(id)) return null
  if (typeof name !== "string" || name.length === 0 || name.length > 64) return null
  if (!isBackgroundFileName(file)) return null

  const entry: BackgroundType = { id, name, file }
  if (isBackgroundThumbnailFileName(thumbnail)) entry.thumbnail = thumbnail
  return entry
}

/**
 * Reads the manifest the `backgrounds` branch serves.
 *
 * Total: a manifest that does not parse, is not an array, or is full of entries the launcher
 * cannot use answers with an empty list rather than throwing, and the settings page shows its
 * failure state on an empty list the same way it does on a refused fetch. Entries are checked one
 * by one so a single malformed row costs that row and not the ten good ones beside it.
 */
export function parseBackgroundManifest(text: string): BackgroundType[] {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []

  const seen = new Set<string>()
  const entries: BackgroundType[] = []

  for (const value of parsed) {
    if (entries.length >= MAX_BACKGROUND_ENTRIES) break
    const entry = parseEntry(value)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }

  return entries
}
