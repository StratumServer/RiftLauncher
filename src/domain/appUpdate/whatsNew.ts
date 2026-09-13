/**
 * Turning a GitHub release list into what the "What's new" dialog and the Info & Help section
 * show, and picking which releases that covers.
 *
 * Release bodies are markdown the launcher's own maintainers write, but they arrive over the
 * network like any other API response, so {@link releaseNotesToBlocks} treats them exactly as
 * untrusted text: reduced to headings, paragraphs and bullets, every markup character stripped,
 * capped in count and length. Nothing here renders HTML, so a hostile body (a script tag, a
 * comment nobody closed, a wall of nested tags) comes out as inert text rather than markup the
 * renderer would have to sanitize.
 */

import { isPrereleaseVersion } from "./betaUpdates"

export interface WhatsNewBlock {
  kind: "heading" | "paragraph" | "bullet"
  text: string
}

export interface WhatsNewLimits {
  maxBlocks: number
  maxBlockLength: number
}

/**
 * 40 blocks and 600 characters each is generous for a real release (the launcher's own releases
 * run a handful of bullets), while still refusing to turn a body written to exhaust the dialog
 * into one that actually does: a huge or repetitive body is capped rather than rendered whole.
 */
export const DEFAULT_WHATS_NEW_LIMITS: WhatsNewLimits = { maxBlocks: 40, maxBlockLength: 600 }

/** How many releases {@link selectReleasesToShow} hands back at most, newest first. */
export const DEFAULT_MAX_RELEASES_TO_SHOW = 5

/**
 * Refused outright before any block parsing runs. Real release notes are a few KB at most; this
 * is headroom for that, not a promise to render a body anywhere near this size. The 256 KiB
 * response cap in src/ipc/handlers/netHandlers.ts already bounds the whole releases list, so this
 * is a second, cheaper floor against one body written to make this function do a lot of work.
 */
const MAX_MARKDOWN_INPUT_LENGTH = 20_000

/**
 * HTML comments and script/style bodies, matched the same defensive way
 * src/domain/mods/moddb.ts matches them: non-greedy, with a fallback to the end of the string so
 * an unterminated comment or script tag in hostile input cannot make the match run away.
 */
const HOSTILE_MARKUP = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi

/** Any remaining tag, stripped whole rather than parsed: a stray `<` ends the match at the next `>` instead of running to the end. */
const ANY_TAG = /<[^<>]*>/g

/** `[link text](url)`: the text survives, the destination never reaches the dialog. */
const MARKDOWN_LINK = /\[([^[\]]*)\]\([^()]*\)/g

/** Bold, italic and inline-code markers. Dropped rather than reproduced: `**bold**` becomes `bold`, not styled text, because nothing downstream renders markup. */
const EMPHASIS_MARKERS = /[*_`]+/g

const ATX_HEADING = /^(#{1,6})\s+(.*)$/
const BULLET_LINE = /^[-*+]\s+(.*)$/

/** Strips markup and markdown formatting from one line's worth of text, then collapses whitespace. */
function toPlainText(raw: string): string {
  return raw.replace(HOSTILE_MARKUP, "").replace(ANY_TAG, "").replace(MARKDOWN_LINK, "$1").replace(EMPHASIS_MARKERS, "").replace(/\s+/g, " ").trim()
}

/**
 * A GitHub release body (markdown) as a capped list of headings, paragraphs and bullets.
 *
 * `#`/`##`/`###` (through `######`) lines become headings, `-`/`*`/`+` lines become bullets, a
 * blank line ends a paragraph, and every other run of non-blank lines is joined into one
 * paragraph. Markdown emphasis, inline code marks and link syntax (the link text is kept, the URL
 * is not) are stripped, along with any HTML tag or comment, before whitespace is collapsed. The
 * result is meant for React text children: nothing here is HTML, and nothing downstream may
 * render it as any.
 *
 * @param markdown The release's `body` field. Anything that is not a string, missing included, is no notes at all.
 * @param limits Caps on how much of a body reaches the screen. Defaults to {@link DEFAULT_WHATS_NEW_LIMITS}.
 */
export function releaseNotesToBlocks(markdown: unknown, limits: WhatsNewLimits = DEFAULT_WHATS_NEW_LIMITS): WhatsNewBlock[] {
  if (typeof markdown !== "string" || markdown.length === 0) return []

  const bounded = markdown.length > MAX_MARKDOWN_INPUT_LENGTH ? markdown.slice(0, MAX_MARKDOWN_INPUT_LENGTH) : markdown
  const lines = bounded.replace(/\r\n?/g, "\n").split("\n")

  const blocks: WhatsNewBlock[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const text = toPlainText(paragraph.join(" "))
    if (text.length > 0) blocks.push({ kind: "paragraph", text: text.slice(0, limits.maxBlockLength) })
    paragraph = []
  }

  for (const rawLine of lines) {
    if (blocks.length >= limits.maxBlocks) break

    const line = rawLine.trim()

    if (line.length === 0) {
      flushParagraph()
      continue
    }

    const heading = ATX_HEADING.exec(line)
    if (heading) {
      flushParagraph()
      const text = toPlainText(heading[2] ?? "")
      if (text.length > 0) blocks.push({ kind: "heading", text: text.slice(0, limits.maxBlockLength) })
      continue
    }

    const bullet = BULLET_LINE.exec(line)
    if (bullet) {
      flushParagraph()
      const text = toPlainText(bullet[1] ?? "")
      if (text.length > 0) blocks.push({ kind: "bullet", text: text.slice(0, limits.maxBlockLength) })
      continue
    }

    paragraph.push(line)
  }

  flushParagraph()

  return blocks.slice(0, limits.maxBlocks)
}

function stripVersionPrefix(version: string): string {
  return version.trim().replace(/^v/i, "")
}

/** One dot-separated run of a version, numeric parts included, and its prerelease identifiers (if any), split the same way semver does. */
function parseWhatsNewVersion(version: string): { release: number[]; prerelease: string[] | null } {
  const bare = stripVersionPrefix(version).split("+", 1)[0] ?? ""
  const dashIndex = bare.indexOf("-")
  const releasePart = dashIndex === -1 ? bare : bare.slice(0, dashIndex)
  const prereleasePart = dashIndex === -1 ? null : bare.slice(dashIndex + 1)

  return {
    release: releasePart.split(".").map((part) => Number(part) || 0),
    prerelease: prereleasePart && prereleasePart.length > 0 ? prereleasePart.split(".") : null
  }
}

/** Compares two prerelease identifiers the way semver precedence does: numeric identifiers sort as numbers, and a numeric one always sorts before an alphanumeric one. */
function compareIdentifiers(a: string, b: string): number {
  const numA = Number(a)
  const numB = Number(b)
  const aIsNumeric = a !== "" && Number.isFinite(numA)
  const bIsNumeric = b !== "" && Number.isFinite(numB)

  if (aIsNumeric && bIsNumeric) return numA - numB
  if (aIsNumeric) return -1
  if (bIsNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Orders two version strings, prerelease suffix included: `1.7.0-beta.9` sorts before
 * `1.7.0-beta.10`, which sorts before `1.7.0`.
 *
 * src/domain/versionNumbers.ts's compareVersions deliberately drops the prerelease suffix instead
 * of ranking it, which is right for the game catalog and the ModDB but wrong here: selecting the
 * releases between two beta versions is the one thing in the launcher that does have to decide
 * whether beta.10 outranks beta.9. Written by hand rather than by adding a `semver` dependency to
 * this file, the same way betaUpdates.ts reads a prerelease with a plain string check instead of
 * one.
 */
function compareWhatsNewVersions(a: string, b: string): number {
  const left = parseWhatsNewVersion(a)
  const right = parseWhatsNewVersion(b)

  for (let index = 0; index < Math.max(left.release.length, right.release.length); index++) {
    const difference = (left.release[index] ?? 0) - (right.release[index] ?? 0)
    if (difference !== 0) return difference
  }

  if (left.prerelease === null && right.prerelease === null) return 0
  if (left.prerelease === null) return 1 // a plain release outranks any prerelease of the same version
  if (right.prerelease === null) return -1

  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    const difference = compareIdentifiers(leftIdentifier, rightIdentifier)
    if (difference !== 0) return difference
  }

  return 0
}

export interface SelectReleasesOptions {
  maxReleases?: number
}

/**
 * The releases to show after an update: tag versions strictly after `previousVersion` and up to
 * and including `currentVersion`, newest first, capped to {@link DEFAULT_MAX_RELEASES_TO_SHOW} by
 * default.
 *
 * Drafts are never shown. A prerelease is shown only when `currentVersion` is itself a prerelease
 * (see betaUpdates.ts's isPrereleaseVersion): a player on a stable build never sees beta notes
 * they cannot even be running yet. A `v` prefix on either version, or on a release's tag, is
 * tolerated throughout.
 *
 * `previousVersion` empty (a fresh install, or the first launch after this feature ships, where
 * there is no stored "last seen" version to widen from) means only the release equal to
 * `currentVersion` is shown, never the whole history: nobody who just installed the launcher
 * needs to be told about every release that ever shipped.
 */
export function selectReleasesToShow(releases: readonly WhatsNewReleaseInfo[], previousVersion: string, currentVersion: string, options: SelectReleasesOptions = {}): WhatsNewReleaseInfo[] {
  const maxReleases = options.maxReleases ?? DEFAULT_MAX_RELEASES_TO_SHOW
  const current = stripVersionPrefix(currentVersion)
  const previous = previousVersion.trim().length > 0 ? stripVersionPrefix(previousVersion) : ""
  const currentIsPrerelease = isPrereleaseVersion(current)

  const inRange = releases.filter((release) => {
    if (release.draft) return false
    if (release.prerelease && !currentIsPrerelease) return false

    const tag = stripVersionPrefix(release.tag)
    if (previous.length === 0) return tag === current

    return compareWhatsNewVersions(tag, previous) > 0 && compareWhatsNewVersions(tag, current) <= 0
  })

  return inRange.sort((a, b) => compareWhatsNewVersions(stripVersionPrefix(b.tag), stripVersionPrefix(a.tag))).slice(0, maxReleases)
}
