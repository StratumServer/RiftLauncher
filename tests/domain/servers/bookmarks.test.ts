import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  checkServerBookmark,
  DEFAULT_GAME_SERVER_PORT,
  formatServerAddress,
  formatServerEndpoint,
  joinTargetUrl,
  MAX_SERVER_BOOKMARK_NAME_LENGTH,
  MAX_SERVER_BOOKMARKS,
  NEVER_LAUNCHED,
  normalizeServerBookmarks,
  orderServerBookmarks,
  resolveServerBookmark
} from "@domain/servers/bookmarks"

function bookmark(overrides: Partial<ServerBookmarkType> = {}): ServerBookmarkType {
  return { id: "s-1", name: "Home", host: "play.example.com", port: DEFAULT_GAME_SERVER_PORT, lastLaunched: NEVER_LAUNCHED, ...overrides }
}

function check(overrides: Partial<{ id: string; name: string; host: string; port: number }> = {}, existing: readonly ServerBookmarkType[] = []): ReturnType<typeof checkServerBookmark> {
  return checkServerBookmark({ id: "s-1", name: "Home", host: "play.example.com", port: DEFAULT_GAME_SERVER_PORT, ...overrides }, existing)
}

describe("checkServerBookmark: the host", () => {
  it("takes a host name", () => {
    const result = check({ host: "play.example.com" })
    assert.deepEqual(result.ok && result.bookmark.host, "play.example.com")
  })

  it("takes a single-label host name, which is what a LAN machine is called", () => {
    assert.equal(check({ host: "nas" }).ok, true)
  })

  it("takes an IPv4 literal", () => {
    assert.equal(check({ host: "192.168.1.20" }).ok, true)
  })

  it("takes an IPv6 literal, bracketed or bare, and stores one form", () => {
    const bracketed = check({ host: "[2001:db8::1]" })
    const bare = check({ host: "2001:db8::1" })

    assert.deepEqual(bracketed.ok && bracketed.bookmark.host, "2001:db8::1")
    assert.deepEqual(bare.ok && bare.bookmark.host, "2001:db8::1")
  })

  it("refuses an address with the port glued onto it, which is the one colon IPv6 never has", () => {
    assert.deepEqual(check({ host: "play.example.com:42420" }), { ok: false, problem: "invalid-host" })
    assert.deepEqual(check({ host: "192.168.1.20:42420" }), { ok: false, problem: "invalid-host" })
    assert.deepEqual(check({ host: "abcd:42420" }), { ok: false, problem: "invalid-host" })
  })

  it("refuses anything that could become a second argument or a different URL", () => {
    for (const host of ["play example.com", "play.example.com/join", "user@play.example.com", "--connect", "play.example.com?a=b", '"play.example.com"']) {
      assert.deepEqual(check({ host }), { ok: false, problem: "invalid-host" }, host)
    }
  })

  it("refuses an empty host, an empty label, and a leading or trailing dot or hyphen", () => {
    for (const host of ["", "play..example.com", ".example.com", "example.com.", "-example.com", "example.com-"]) {
      assert.deepEqual(check({ host }), { ok: false, problem: "invalid-host" }, host)
    }
  })

  it("refuses a host past 253 characters", () => {
    assert.deepEqual(check({ host: "a".repeat(254) }), { ok: false, problem: "invalid-host" })
  })

  it("trims what the player typed around the address", () => {
    const result = check({ host: "  play.example.com  " })
    assert.deepEqual(result.ok && result.bookmark.host, "play.example.com")
  })
})

describe("checkServerBookmark: the port", () => {
  it("takes the whole range, privileged ports included", () => {
    assert.equal(check({ port: 1 }).ok, true)
    assert.equal(check({ port: 443 }).ok, true)
    assert.equal(check({ port: 65_535 }).ok, true)
  })

  it("refuses a port outside the range, a fraction, and anything that is not a number", () => {
    for (const port of [0, -1, 65_536, 42_420.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(check({ port }), { ok: false, problem: "invalid-port" }, String(port))
    }
  })
})

describe("checkServerBookmark: the name", () => {
  it("refuses an empty name, and a name that is only spaces", () => {
    assert.deepEqual(check({ name: "" }), { ok: false, problem: "empty-name" })
    assert.deepEqual(check({ name: "   " }), { ok: false, problem: "empty-name" })
  })

  it("refuses a name past the cap and keeps one exactly at it", () => {
    assert.equal(check({ name: "n".repeat(MAX_SERVER_BOOKMARK_NAME_LENGTH) }).ok, true)
    assert.deepEqual(check({ name: "n".repeat(MAX_SERVER_BOOKMARK_NAME_LENGTH + 1) }), { ok: false, problem: "name-too-long" })
  })

  it("refuses a name carrying a control character", () => {
    assert.deepEqual(check({ name: "Ho\u0007me" }), { ok: false, problem: "control-character" })
    assert.deepEqual(check({ name: "Ho\nme" }), { ok: false, problem: "control-character" })
    assert.deepEqual(check({ name: "Home\u001b[2J" }), { ok: false, problem: "control-character" })
  })

  it("trims the name it stores", () => {
    const result = check({ name: "  Home  " })
    assert.deepEqual(result.ok && result.bookmark.name, "Home")
  })
})

describe("checkServerBookmark: duplicates", () => {
  it("refuses the same host and port again, whatever the name and whatever the case", () => {
    const existing = [bookmark({ id: "s-9", host: "Play.Example.com" })]
    assert.deepEqual(check({ id: "s-1", name: "Another name", host: "play.example.com" }, existing), { ok: false, problem: "duplicate" })
  })

  it("takes the same host on a different port", () => {
    const existing = [bookmark({ id: "s-9", port: 42_421 })]
    assert.equal(check({}, existing).ok, true)
  })

  it("lets a bookmark being edited keep its own address", () => {
    const existing = [bookmark({ id: "s-1" })]
    assert.equal(check({ id: "s-1", name: "Renamed" }, existing).ok, true)
  })

  it("keeps the launch stamp of the bookmark being edited", () => {
    const existing = [bookmark({ id: "s-1", lastLaunched: 1_700_000_000_000 })]
    const result = check({ id: "s-1", name: "Renamed" }, existing)
    assert.deepEqual(result.ok && result.bookmark.lastLaunched, 1_700_000_000_000)
  })

  it("starts a new bookmark as never launched", () => {
    const result = check()
    assert.deepEqual(result.ok && result.bookmark.lastLaunched, NEVER_LAUNCHED)
  })
})

describe("joinTargetUrl", () => {
  it("spells the scheme the game's own handler is registered for", () => {
    assert.equal(joinTargetUrl({ host: "play.example.com", port: DEFAULT_GAME_SERVER_PORT }), "vintagestoryjoin://play.example.com:42420")
  })

  it("keeps the port even when it is the default one", () => {
    assert.equal(joinTargetUrl({ host: "192.168.1.20", port: 42_420 }), "vintagestoryjoin://192.168.1.20:42420")
  })

  it("brackets an IPv6 literal so the address's colons cannot be read as the port", () => {
    assert.equal(joinTargetUrl({ host: "2001:db8::1", port: 30_000 }), "vintagestoryjoin://[2001:db8::1]:30000")
    assert.equal(joinTargetUrl({ host: "::1", port: DEFAULT_GAME_SERVER_PORT }), "vintagestoryjoin://[::1]:42420")
  })
})

describe("server endpoint formatting", () => {
  it("brackets IPv6 when a non-default port is appended", () => {
    assert.equal(formatServerEndpoint({ host: "2001:db8::1", port: 30_000 }), "[2001:db8::1]:30000")
    assert.equal(formatServerAddress({ host: "2001:db8::1", port: 30_000 }), "[2001:db8::1]:30000")
  })

  it("keeps the compact default-port address for IPv4 and IPv6", () => {
    assert.equal(formatServerAddress({ host: "2001:db8::1", port: DEFAULT_GAME_SERVER_PORT }), "2001:db8::1")
    assert.equal(formatServerAddress({ host: "play.example.com", port: DEFAULT_GAME_SERVER_PORT }), "play.example.com")
  })
})

describe("normalizeServerBookmarks", () => {
  it("reads a stored list back unchanged", () => {
    const stored = [bookmark({ id: "s-1", lastLaunched: 5 }), bookmark({ id: "s-2", host: "other.example.com" })]
    assert.deepEqual(normalizeServerBookmarks(stored), stored)
  })

  it("answers an empty list for anything that is not an array", () => {
    for (const value of [null, undefined, {}, "servers", 7]) assert.deepEqual(normalizeServerBookmarks(value), [])
  })

  it("drops a junk entry without losing the rest, which is what a stranger's modpack needs", () => {
    const list = normalizeServerBookmarks([
      null,
      "a string",
      { id: "s-1", name: "Home", host: "play.example.com", port: DEFAULT_GAME_SERVER_PORT },
      { id: "", name: "No id", host: "a.example.com", port: 1 },
      { id: "s-3", name: "", host: "b.example.com", port: 1 },
      { id: "s-4", name: "Bad host", host: "not a host", port: 1 },
      { id: "s-5", name: "Bad port", host: "c.example.com", port: 0 },
      { id: "s-6", name: "Same address", host: "play.example.com", port: DEFAULT_GAME_SERVER_PORT }
    ])

    assert.deepEqual(
      list.map((server) => server.id),
      ["s-1"]
    )
  })

  it("defaults a missing or unreadable launch stamp to never launched", () => {
    const list = normalizeServerBookmarks([
      { id: "s-1", name: "Home", host: "a.example.com", port: 1 },
      { id: "s-2", name: "Away", host: "b.example.com", port: 1, lastLaunched: "yesterday" }
    ])

    assert.deepEqual(
      list.map((server) => server.lastLaunched),
      [NEVER_LAUNCHED, NEVER_LAUNCHED]
    )
  })

  it("caps the list, so a hostile pack cannot grow it without bound", () => {
    const many = Array.from({ length: MAX_SERVER_BOOKMARKS + 10 }, (_, index) => bookmark({ id: `s-${index}`, host: `h${index}.example.com` }))
    assert.equal(normalizeServerBookmarks(many).length, MAX_SERVER_BOOKMARKS)
  })

  /**
   * The duplicate check excludes a bookmark's own id on purpose, so an edit does not collide with
   * itself. That leaves one id twice with two addresses looking like two fine rows, and everything
   * downstream keys off the id: the import dialog's checkboxes, the row's Edit and its Remove.
   */
  it("keeps the first entry for an id and drops a second one wearing it", () => {
    const list = normalizeServerBookmarks([
      { id: "same", name: "One", host: "a.example.com", port: DEFAULT_GAME_SERVER_PORT },
      { id: "same", name: "Two", host: "b.example.com", port: DEFAULT_GAME_SERVER_PORT },
      { id: "other", name: "Three", host: "c.example.com", port: DEFAULT_GAME_SERVER_PORT }
    ])

    assert.deepEqual(
      list.map((server) => server.name),
      ["One", "Three"]
    )
  })
})

describe("orderServerBookmarks", () => {
  it("puts the most recently launched first and the never-launched last", () => {
    const list = [bookmark({ id: "never" }), bookmark({ id: "older", host: "a.example.com", lastLaunched: 10 }), bookmark({ id: "newer", host: "b.example.com", lastLaunched: 20 })]

    assert.deepEqual(
      orderServerBookmarks(list).map((server) => server.id),
      ["newer", "older", "never"]
    )
  })

  it("leaves the stored list alone", () => {
    const list = [bookmark({ id: "never" }), bookmark({ id: "played", host: "a.example.com", lastLaunched: 10 })]
    orderServerBookmarks(list)
    assert.deepEqual(
      list.map((server) => server.id),
      ["never", "played"]
    )
  })
})

describe("resolveServerBookmark", () => {
  const installations = [{ id: "i-1", servers: [bookmark({ id: "s-1" })] }, { id: "i-2", servers: [bookmark({ id: "s-2", host: "other.example.com" })] }, { id: "i-3" }] as InstallationType[]

  it("finds a bookmark inside its own Installation", () => {
    assert.equal(resolveServerBookmark(installations, "i-1", "s-1")?.host, "play.example.com")
  })

  it("never reaches another Installation's bookmark", () => {
    assert.equal(resolveServerBookmark(installations, "i-1", "s-2"), null)
  })

  it("answers null for an unknown id and for an Installation with no list at all", () => {
    assert.equal(resolveServerBookmark(installations, "i-1", "nope"), null)
    assert.equal(resolveServerBookmark(installations, "i-3", "s-1"), null)
    assert.equal(resolveServerBookmark(installations, "nope", "s-1"), null)
  })
})
