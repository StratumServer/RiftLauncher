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
 *
 * It is also a reducer of the markdown this project actually publishes, not a generic sanitizer:
 * tests/domain/appUpdate/whatsNew.test.ts runs it over the real bodies of v1.7.0-beta.7, beta.8
 * and beta.9 and pins the block sequence each one produces, so a change here is measured against
 * the notes players will read rather than against invented input.
 */

import semver from "semver"

import { isPrereleaseVersion } from "./betaUpdates"

export interface WhatsNewBlock {
  kind: "heading" | "paragraph" | "bullet"
  text: string
}

/**
 * 120 blocks and 2000 characters each covers the longest release this project has published
 * (beta.7, thirty-six changes, lands well inside both), while still refusing to render a body
 * written to exhaust the dialog: past the block count the last block becomes
 * {@link MORE_ON_THE_RELEASES_PAGE} and the rest is left on the releases page.
 */
const MAX_BLOCKS = 120
const MAX_BLOCK_LENGTH = 2000

/**
 * The block that replaces everything past {@link MAX_BLOCKS}, so a body that was cut says so
 * instead of ending mid-thought. A bare ellipsis rather than a sentence: both screens already sit
 * above an "All releases" button that is where the rest of the notes live.
 */
export const MORE_ON_THE_RELEASES_PAGE = "…"

/** How many releases {@link selectReleasesToShow} and {@link selectLatestReleases} hand back at most, newest first. */
export const DEFAULT_MAX_RELEASES_TO_SHOW = 5

/**
 * 64 KiB of markdown, sliced before any parsing runs. Real release notes are a few KB (the
 * longest this project has published is under 7 KB); this is headroom for that, not a promise to
 * render a body anywhere near this size. The 256 KiB response cap in
 * src/ipc/handlers/netHandlers.ts already bounds the whole releases list, and that file caps each
 * body on its own before it crosses IPC, so this is the last of three floors rather than the only
 * one.
 */
const MAX_MARKDOWN_INPUT_LENGTH = 64 * 1024

/** Matched non-greedily with a fallback to the end of the string, the same defensive shape src/domain/mods/moddb.ts uses, so an unterminated comment cannot make the match run away. Stripped over the whole body before any line is looked at, so a comment spanning several lines takes all of them with it. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g

/** A script or style element, body included, on the same whole-body pass and for the same reason. */
const SCRIPT_OR_STYLE = /<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi

/**
 * Something shaped like a real HTML tag, stripped whole rather than parsed: a name with no
 * attributes (`<b>`, `</div>`, `<br/>`, `<img>`) or a name with something that at least contains
 * an `=` (`<img src="x.png">`). Prose keeps its own angle brackets that way, which release notes
 * do use: `a<b`, `5 < 10`, and `exited with errors!` inside a `<` comparison all survive.
 */
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s*\/?>|\s+[^<>]*=[^<>]*\/?>)/g

/** `![alt](url)`: dropped whole, alt text included. Nothing downstream can render an image, and an alt text alone reads as a stray word in the middle of a sentence. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^()]*\)/g

/** `[link text](url)`: the text survives, the destination never reaches the dialog. */
const MARKDOWN_LINK = /\[([^[\]]*)\]\([^()]*\)/g

/** Bold, italic, inline-code and strikethrough markers. Dropped rather than reproduced, since nothing downstream renders markup, but only where they are markers (see {@link stripEmphasisMarkers}). */
const EMPHASIS_RUN = /[*_`~]+/g

/** The five entities GitHub's own markdown writes, and nothing else: a decoder that handled every named entity would be a second parser to keep honest. */
const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }
const HTML_ENTITY = /&(?:amp|lt|gt|quot|#39);/g

const WORD_CHARACTER = /[\p{L}\p{N}]/u

const ATX_HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const SETEXT_UNDERLINE = /^(?:=+|-+)\s*$/
const THEMATIC_BREAK = /^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/
const CODE_FENCE = /^(?:```|~~~)/
const BULLET_LINE = /^[-*+]\s+(.*)$/
const ORDERED_LINE = /^(\d{1,9})[.)]\s+(.*)$/
const TABLE_SEPARATOR_LINE = /^[-:\s|]+$/

const isTight = (character: string): boolean => character !== "" && !/\s/.test(character)

/**
 * Strips `*`, `_`, `` ` `` and `~` only where they are emphasis markers, which is to say at a
 * word's edge.
 *
 * A run with a word character on both sides is inside a word (`snake_case`, `mesa_glthread`, the
 * `clientsettings_json` shape a filename takes) and a run with whitespace on both sides is a
 * character of its own (`5 * 3`); both survive. Everything else opened or closed something and
 * goes. Whole-line markup (a bullet, a table, a fence) is classified before this runs, so a
 * leading `*` never reaches it as a marker.
 */
function stripEmphasisMarkers(text: string): string {
  return text.replace(EMPHASIS_RUN, (run: string, index: number) => {
    const before = index > 0 ? (text[index - 1] ?? "") : ""
    const after = text[index + run.length] ?? ""

    const intraword = WORD_CHARACTER.test(before) && WORD_CHARACTER.test(after)
    const isolated = !isTight(before) && !isTight(after)

    return intraword || isolated ? run : ""
  })
}

/** Strips markup and markdown formatting from one block's worth of text, decodes the five entities above, then collapses whitespace. */
function toPlainText(raw: string): string {
  return stripEmphasisMarkers(raw.replace(MARKDOWN_IMAGE, "").replace(MARKDOWN_LINK, "$1").replace(HTML_TAG, ""))
    .replace(HTML_ENTITY, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * One block's text, cut at a word boundary with an ellipsis when it runs past {@link MAX_BLOCK_LENGTH}.
 *
 * The cut never lands between a surrogate pair's two halves, which would leave a lone half that
 * renders as a replacement character: the last space inside the budget is the normal cut, and the
 * hard cut backs up one unit when it would split a pair.
 */
function capBlockText(text: string): string {
  if (text.length <= MAX_BLOCK_LENGTH) return text

  const room = MAX_BLOCK_LENGTH - MORE_ON_THE_RELEASES_PAGE.length
  const lastSpace = text.slice(0, room).lastIndexOf(" ")
  let cut = lastSpace > 0 ? lastSpace : room
  const previous = text.charCodeAt(cut - 1)
  if (previous >= 0xd800 && previous <= 0xdbff) cut -= 1

  return `${text.slice(0, cut).trimEnd()}${MORE_ON_THE_RELEASES_PAGE}`
}

/** The body sliced to {@link MAX_MARKDOWN_INPUT_LENGTH}, never through the middle of a surrogate pair. */
function boundInput(markdown: string): string {
  if (markdown.length <= MAX_MARKDOWN_INPUT_LENGTH) return markdown

  const last = markdown.charCodeAt(MAX_MARKDOWN_INPUT_LENGTH - 1)
  return markdown.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_MARKDOWN_INPUT_LENGTH - 1 : MAX_MARKDOWN_INPUT_LENGTH)
}

/**
 * A GitHub release body (markdown) as a capped list of headings, paragraphs and bullets.
 *
 * What each construct becomes:
 *  - `#` through `######`, and a line underlined with `===` or `---`, become headings;
 *  - `-`/`*`/`+` lines become bullets, nesting flattened, and `1.`/`1)` lines become bullets that
 *    keep their number, since nothing downstream can render an indent or a counter;
 *  - a blank line ends a paragraph, and every other run of non-blank lines joins into one;
 *  - images, table rows, thematic breaks and fenced code blocks are dropped. A fence is dropped
 *    rather than flattened because its meaning is carried by the line breaks and the indentation
 *    this function collapses: a command turned into one run-on paragraph is worse than the
 *    releases-page link both screens already offer;
 *  - link text survives, the URL does not; emphasis markers go only where they are markers; the
 *    five entities GitHub writes are decoded; every HTML tag, comment and script body is stripped.
 *
 * The result is meant for React text children: nothing here is HTML, and nothing downstream may
 * render it as any.
 *
 * @param markdown The release's `body` field. Anything that is not a string, missing included, is no notes at all.
 */
export function releaseNotesToBlocks(markdown: unknown): WhatsNewBlock[] {
  if (typeof markdown !== "string" || markdown.length === 0) return []

  const body = boundInput(markdown).replace(HTML_COMMENT, "").replace(SCRIPT_OR_STYLE, "")
  const lines = body.replace(/\r\n?/g, "\n").split("\n")

  const blocks: WhatsNewBlock[] = []
  let paragraph: string[] = []
  let inCodeFence = false

  const push = (kind: WhatsNewBlock["kind"], raw: string, prefix = ""): void => {
    const text = toPlainText(raw)
    if (text.length > 0) blocks.push({ kind, text: capBlockText(`${prefix}${text}`) })
  }

  const flushParagraph = (kind: WhatsNewBlock["kind"] = "paragraph"): void => {
    if (paragraph.length === 0) return
    const joined = paragraph.join(" ")
    paragraph = []
    push(kind, joined)
  }

  for (const rawLine of lines) {
    // One past the cap: enough to know the body was cut without reading the rest of it.
    if (blocks.length > MAX_BLOCKS) break

    // Left-trimmed only: a nested bullet flattens onto the same level, while the trailing space
    // of a line a whole-body comment strip emptied out (`# ` from `# <!-- ... -->`) still lets the
    // heading classifier match and drop it, instead of leaving a bare `#` on screen as a paragraph.
    const line = rawLine.trimStart()

    if (CODE_FENCE.test(line)) {
      if (!inCodeFence) flushParagraph()
      inCodeFence = !inCodeFence
      continue
    }

    if (inCodeFence) continue

    if (line.length === 0) {
      flushParagraph()
      continue
    }

    // A table's own rows, and a separator row written without the leading pipe. Markdown tables
    // carry their meaning in columns, which a list of text blocks has nowhere to put.
    if (line.startsWith("|") || (line.includes("|") && TABLE_SEPARATOR_LINE.test(line))) {
      flushParagraph()
      continue
    }

    // `===`/`---` under a paragraph underlines it into a heading; the same run of dashes with
    // nothing above it is a thematic break, which the next branch drops.
    if (SETEXT_UNDERLINE.test(line) && paragraph.length > 0) {
      flushParagraph("heading")
      continue
    }

    if (THEMATIC_BREAK.test(line)) {
      flushParagraph()
      continue
    }

    const heading = ATX_HEADING.exec(line)
    if (heading) {
      flushParagraph()
      push("heading", heading[2] ?? "")
      continue
    }

    const bullet = BULLET_LINE.exec(line)
    if (bullet) {
      flushParagraph()
      push("bullet", bullet[1] ?? "")
      continue
    }

    const ordered = ORDERED_LINE.exec(line)
    if (ordered) {
      flushParagraph()
      push("bullet", ordered[2] ?? "", `${ordered[1] ?? ""}. `)
      continue
    }

    paragraph.push(line)
  }

  flushParagraph()

  if (blocks.length > MAX_BLOCKS) return [...blocks.slice(0, MAX_BLOCKS - 1), { kind: "paragraph", text: MORE_ON_THE_RELEASES_PAGE }]

  return blocks
}

function stripVersionPrefix(version: string): string {
  return version.trim().replace(/^v/i, "")
}

/**
 * Orders two version strings, prerelease suffix included: `1.7.0-beta.9` sorts before
 * `1.7.0-beta.10`, which sorts before `1.7.0`.
 *
 * src/domain/versionNumbers.ts's compareVersions deliberately drops the prerelease suffix instead
 * of ranking it, which is right for the game catalog and the ModDB but wrong here: selecting the
 * releases between two beta versions is the one thing in the launcher that does have to decide
 * whether beta.10 outranks beta.9. That is semver's own precedence rule, and `semver` is already
 * how src/domain/versions/detect.ts, src/domain/mods/compatibility.ts and src/domain/mods/health.ts
 * read a version in this same layer.
 *
 * A tag semver refuses sorts before every tag it accepts, so it lands last newest-first and never
 * falls inside the dialog's window; among themselves those sort alphabetically, so the order is the
 * same on every render. That guard is the shape src/renderer/src/utils/gameVersionOrder.ts already
 * ships for the same problem, and it is what keeps a throw out of a sort callback.
 */
function compareWhatsNewVersions(a: string, b: string): number {
  const left = semver.valid(a)
  const right = semver.valid(b)

  if (left && right) return semver.compare(left, right)
  if (left) return 1
  if (right) return -1
  return a.localeCompare(b)
}

/** Newest tag first, the one order both screens list releases in. */
function newestTagFirst(a: WhatsNewReleaseInfo, b: WhatsNewReleaseInfo): number {
  return compareWhatsNewVersions(stripVersionPrefix(b.tag), stripVersionPrefix(a.tag))
}

/**
 * Drafts are never shown. A prerelease is shown only when `currentVersion` is itself a prerelease
 * (see betaUpdates.ts's isPrereleaseVersion): a player on a stable build never sees beta notes
 * they cannot even be running yet.
 */
function isShowable(release: WhatsNewReleaseInfo, currentIsPrerelease: boolean): boolean {
  if (release.draft) return false
  return !release.prerelease || currentIsPrerelease
}

/**
 * The releases to show after an update: tag versions strictly after `previousVersion` and up to
 * and including `currentVersion`, newest first, capped to {@link DEFAULT_MAX_RELEASES_TO_SHOW}.
 * This is the dialog's window; the Info & Help section uses {@link selectLatestReleases}, which has
 * no window at all.
 *
 * A `v` prefix on either version, or on a release's tag, is tolerated throughout.
 *
 * `previousVersion` empty (a fresh install, or the first launch after this feature ships, where
 * there is no stored "last seen" version to widen from) means only the release equal to
 * `currentVersion` is shown, never the whole history: nobody who just installed the launcher
 * needs to be told about every release that ever shipped.
 */
export function selectReleasesToShow(releases: readonly WhatsNewReleaseInfo[], previousVersion: string, currentVersion: string): WhatsNewReleaseInfo[] {
  const current = stripVersionPrefix(currentVersion)
  const previous = previousVersion.trim().length > 0 ? stripVersionPrefix(previousVersion) : ""
  const currentIsPrerelease = isPrereleaseVersion(current)

  const inRange = releases.filter((release) => {
    if (!isShowable(release, currentIsPrerelease)) return false

    const tag = stripVersionPrefix(release.tag)
    if (previous.length === 0) return tag === current

    return compareWhatsNewVersions(tag, previous) > 0 && compareWhatsNewVersions(tag, current) <= 0
  })

  return inRange.sort(newestTagFirst).slice(0, DEFAULT_MAX_RELEASES_TO_SHOW)
}

/**
 * The latest releases, newest first, capped the same way, with no upper or lower bound at all:
 * what Info & Help lists on every launch whatever the player has already seen.
 *
 * Deliberately not {@link selectReleasesToShow}'s window. That window exists so the dialog
 * interrupts a player exactly once with exactly the releases they missed; a player who opens Info
 * & Help is asking for the notes, and the answer must not depend on whether they read them
 * yesterday (#442's Info & Help section went empty from the second launch onward for that reason).
 * `currentVersion` is still read, for the prerelease rule alone: a stable build never lists beta
 * notes.
 */
export function selectLatestReleases(releases: readonly WhatsNewReleaseInfo[], currentVersion: string): WhatsNewReleaseInfo[] {
  const currentIsPrerelease = isPrereleaseVersion(stripVersionPrefix(currentVersion))

  return releases
    .filter((release) => isShowable(release, currentIsPrerelease))
    .sort(newestTagFirst)
    .slice(0, DEFAULT_MAX_RELEASES_TO_SHOW)
}
