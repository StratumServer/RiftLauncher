/**
 * Server bookmarks an Installation carries, and the join target they build.
 *
 * Pure: no host, no React, no config. The rules live here because three callers need exactly the
 * same ones and must never disagree about them: the Add/Edit dialog, the config normalizer that
 * reads `installation.servers` back off disk, and the modpack reader, which is handed a stranger's
 * file.
 *
 * ## Why the host rule is deliberately shallow
 *
 * A bookmark's host ends up as part of one argv entry the launcher hands the game. What makes that
 * safe is the character class, not a structural parse: `[A-Za-z0-9.-]` (or hex and colons for an
 * IPv6 literal) has no space, no quote, no slash and no `@`, so nothing a player types can become a
 * second argument or a different URL. Going further and parsing the address properly would only
 * duplicate what the game's own resolver does a moment later, and would refuse setups that work.
 *
 * The one structural rule that earns its place is the colon count on the bare IPv6 form: every real
 * IPv6 literal carries at least two colons, and `host:port` carries exactly one, so a player who
 * glues the port onto the address is told so instead of having it silently accepted as a hostname.
 */

/** The port a Vintage Story server listens on unless it was told otherwise. */
export const DEFAULT_GAME_SERVER_PORT = 42420

/**
 * Ports a bookmark may name.
 *
 * The whole range, not 1024 and up: a server behind 443 to get through a restrictive network is a
 * real setup, and nothing about a privileged port makes it less safe to connect to.
 */
export const MIN_GAME_SERVER_PORT = 1
export const MAX_GAME_SERVER_PORT = 65_535

/** How many bookmarks one Installation keeps. Generous for the real use, and a bound on a hostile pack. */
export const MAX_SERVER_BOOKMARKS = 50

export const MAX_SERVER_BOOKMARK_NAME_LENGTH = 64

/** What `lastLaunched` holds for a bookmark the launcher has never started the game on. */
export const NEVER_LAUNCHED = -1

export type ServerBookmarkProblem = "empty-name" | "name-too-long" | "control-character" | "invalid-host" | "invalid-port" | "duplicate"

export type ServerBookmarkCheck = { ok: true; bookmark: ServerBookmarkType } | { ok: false; problem: ServerBookmarkProblem }

/** A hostname or an IPv4 literal: labels of letters, digits and hyphens, separated by single dots. */
const HOST_NAME_PATTERN = /^(?![-.])(?!.*\.\.)[A-Za-z0-9.-]{1,253}(?<![-.])$/

/** An IPv6 literal, bare or bracketed. Only hex digits and colons, and never a lone `host:port` colon. */
const IPV6_PATTERN = /^[0-9A-Fa-f:]{2,45}$/

const CONTROL_CHARACTERS = /\p{Cc}/u

/** Strips the brackets a player may have typed around an IPv6 literal, so one stored form exists. */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

function isIpv6Literal(host: string): boolean {
  return IPV6_PATTERN.test(host) && host.split(":").length > 2
}

/** True for a host the launcher will put in a join URL: a hostname, an IPv4 literal, or an IPv6 one. */
export function isValidServerHost(host: string): boolean {
  return HOST_NAME_PATTERN.test(host) || isIpv6Literal(host)
}

/**
 * Checks one bookmark the player typed against the ones this Installation already has.
 *
 * `id` is required rather than invented here: this stays pure, and an id that is only sometimes
 * there is an id a caller eventually forgets to set. An edit passes the bookmark's own id, which
 * is also what keeps it from colliding with itself in the duplicate check.
 */
export function checkServerBookmark(input: { id: string; name: string; host: string; port: number }, existing: readonly ServerBookmarkType[]): ServerBookmarkCheck {
  const name = input.name.trim()
  if (!name) return { ok: false, problem: "empty-name" }
  if (name.length > MAX_SERVER_BOOKMARK_NAME_LENGTH) return { ok: false, problem: "name-too-long" }
  if (CONTROL_CHARACTERS.test(name)) return { ok: false, problem: "control-character" }

  const host = unbracket(input.host.trim())
  if (!isValidServerHost(host)) return { ok: false, problem: "invalid-host" }

  const port = input.port
  if (!Number.isInteger(port) || port < MIN_GAME_SERVER_PORT || port > MAX_GAME_SERVER_PORT) return { ok: false, problem: "invalid-port" }

  const duplicate = existing.some((server) => server.id !== input.id && server.host.toLowerCase() === host.toLowerCase() && server.port === port)
  if (duplicate) return { ok: false, problem: "duplicate" }

  const previous = existing.find((server) => server.id === input.id)
  return { ok: true, bookmark: { id: input.id, name, host, port, lastLaunched: previous?.lastLaunched ?? NEVER_LAUNCHED } }
}

/**
 * The single place the join URL is spelled.
 *
 * Takes parts that have already been through {@link checkServerBookmark}, so nothing here escapes
 * or repairs anything: an IPv6 literal gets its brackets back because that is the only way a URL
 * can tell the address's colons from the port's, and that is the whole of it.
 */
export function joinTargetUrl(server: Pick<ServerBookmarkType, "host" | "port">): string {
  const host = server.host.includes(":") ? `[${server.host}]` : server.host
  return `vintagestoryjoin://${host}:${server.port}`
}

/**
 * Reads a stored or imported list, keeping what is usable and dropping the rest.
 *
 * Used by the config normalizer and by the modpack reader, which is what the two of them agreeing
 * means in practice. Tolerant on purpose: a single unreadable row must not cost a player the rest
 * of their list, nor make a modpack refuse to open.
 */
export function normalizeServerBookmarks(value: unknown): ServerBookmarkType[] {
  if (!Array.isArray(value)) return []

  const bookmarks: ServerBookmarkType[] = []
  for (const entry of value) {
    if (bookmarks.length >= MAX_SERVER_BOOKMARKS) break
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === "string" ? record.id : ""
    if (!id || id.length > 128) continue
    if (typeof record.name !== "string" || typeof record.host !== "string" || typeof record.port !== "number") continue

    const checked = checkServerBookmark({ id, name: record.name, host: record.host, port: record.port }, bookmarks)
    if (!checked.ok) continue

    const lastLaunched = typeof record.lastLaunched === "number" && Number.isFinite(record.lastLaunched) ? record.lastLaunched : NEVER_LAUNCHED
    bookmarks.push({ ...checked.bookmark, lastLaunched })
  }

  return bookmarks
}

/** Most recently launched first, never-launched last, ties left in the order they were added. */
export function orderServerBookmarks(list: readonly ServerBookmarkType[]): ServerBookmarkType[] {
  return [...list].sort((a, b) => b.lastLaunched - a.lastLaunched)
}

/** The stored bookmark an id names inside one Installation, or null when either id names nothing. */
export function resolveServerBookmark(installations: readonly InstallationType[], installationId: string, serverId: string): ServerBookmarkType | null {
  const installation = installations.find((candidate) => candidate.id === installationId)
  return installation?.servers?.find((server) => server.id === serverId) ?? null
}
