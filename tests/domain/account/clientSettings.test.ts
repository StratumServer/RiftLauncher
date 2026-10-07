import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  CLIENT_SETTINGS_FILE_NAME,
  clearForeignClientSettingsSession,
  mergeSessionIntoClientSettings,
  removeSessionFromClientSettings,
  writeClientSettingsSession
} from "../../../src/domain/account/clientSettings"
import type { AccountSessionFields } from "../../../src/domain/account/clientSettings"
import type { JsonFile, JsonFileReadResult, JsonFileSetAsideResult, JsonFileWriteResult } from "../../../src/domain/ports"

const SETTINGS_PATH = `/data/survival/${CLIENT_SETTINGS_FILE_NAME}`

const SESSION: AccountSessionFields = {
  mptoken: "mp-token",
  sessionKey: "session-key",
  sessionSignature: "session-signature",
  email: "player@example.com",
  playerEntitlements: "singleplayer,multiplayer",
  playerUid: "uid-1",
  playerName: "Player One",
  hostGameServer: true
}

/** The eight keys the game reads its session out of, spelled the way it spells them. */
const GAME_SESSION_KEYS = ["mptoken", "sessionkey", "sessionsignature", "useremail", "entitlements", "playeruid", "playername", "hostgameserver"]

const WRITTEN_SESSION = {
  mptoken: "mp-token",
  sessionkey: "session-key",
  sessionsignature: "session-signature",
  useremail: "player@example.com",
  entitlements: "singleplayer,multiplayer",
  playeruid: "uid-1",
  playername: "Player One",
  hostgameserver: true
}

function stringSettingsOf(document: Record<string, unknown>): Record<string, unknown> {
  return document.stringSettings as Record<string, unknown>
}

/** What the host names a file it set aside, as it answers one. The domain never builds this name. */
const KEPT_NAME = "clientsettings.unreadable-2026-10-07T12-34-56-789Z.json"

interface FakeJsonFile {
  jsonFile: JsonFile
  writes: { path: string; document: unknown }[]
  /** The paths asked to be set aside, in order. */
  setAsides: string[]
  /** Every write and set-aside in the order they happened, which is what tells a file kept from a file overwritten. */
  events: string[]
}

/** The host cannot move the file: the default, so a test that is not about set-asides never sees one succeed. */
const CANNOT_SET_ASIDE: JsonFileSetAsideResult = { ok: false }

function fakeJsonFile(read: JsonFileReadResult = { ok: true, document: undefined }, write: JsonFileWriteResult = { ok: true }, setAside: JsonFileSetAsideResult = CANNOT_SET_ASIDE): FakeJsonFile {
  const writes: { path: string; document: unknown }[] = []
  const setAsides: string[] = []
  const events: string[] = []

  return {
    writes,
    setAsides,
    events,
    jsonFile: {
      read: async () => read,
      write: async (path: string, document: unknown): Promise<JsonFileWriteResult> => {
        writes.push({ path, document })
        events.push("write")
        return write
      },
      setAside: async (path: string): Promise<JsonFileSetAsideResult> => {
        setAsides.push(path)
        events.push("set-aside")
        return setAside
      }
    }
  }
}

describe("mergeSessionIntoClientSettings on a normal document", () => {
  it("writes the eight keys the game reads, under the game's spelling", () => {
    const merged = mergeSessionIntoClientSettings(undefined, SESSION)

    assert.deepEqual(Object.keys(stringSettingsOf(merged)), GAME_SESSION_KEYS)
    assert.deepEqual(stringSettingsOf(merged), WRITTEN_SESSION)
  })

  it("produces a whole document when there was no settings file", () => {
    assert.deepEqual(mergeSessionIntoClientSettings(undefined, SESSION), { stringSettings: WRITTEN_SESSION })
  })

  it("keeps every other section of the document untouched", () => {
    const merged = mergeSessionIntoClientSettings({ intSettings: { maxFps: 60 }, floatSettings: { musicLevel: 0.5 } }, SESSION)

    assert.deepEqual(merged.intSettings, { maxFps: 60 })
    assert.deepEqual(merged.floatSettings, { musicLevel: 0.5 })
  })

  it("keeps the string settings the player already had", () => {
    const merged = mergeSessionIntoClientSettings({ stringSettings: { language: "es-es", masterserverUrl: "https://example.invalid" } }, SESSION)

    assert.equal(stringSettingsOf(merged).language, "es-es")
    assert.equal(stringSettingsOf(merged).masterserverUrl, "https://example.invalid")
  })

  it("replaces a session that was already in the file", () => {
    const merged = mergeSessionIntoClientSettings({ stringSettings: { sessionkey: "stale", playername: "Someone Else" } }, SESSION)

    assert.equal(stringSettingsOf(merged).sessionkey, "session-key")
    assert.equal(stringSettingsOf(merged).playername, "Player One")
  })

  it("passes an absent multiplayer token through as null rather than dropping the key", () => {
    const merged = mergeSessionIntoClientSettings({}, { ...SESSION, mptoken: null })

    assert.equal(stringSettingsOf(merged).mptoken, null)
    assert.ok("mptoken" in stringSettingsOf(merged))
  })

  it("passes an account with no entitlements through as null rather than dropping the key", () => {
    // The game sets ClientSettings.Entitlements straight from this value, null
    // included, so writing null here is what an account with no entitlements
    // (issue #74) is supposed to produce.
    const merged = mergeSessionIntoClientSettings({}, { ...SESSION, playerEntitlements: null })

    assert.equal(stringSettingsOf(merged).entitlements, null)
    assert.ok("entitlements" in stringSettingsOf(merged))
  })

  it("writes the game server flag as a boolean", () => {
    const merged = mergeSessionIntoClientSettings({}, { ...SESSION, hostGameServer: false })

    assert.equal(stringSettingsOf(merged).hostgameserver, false)
  })

  it("leaves the document it was given alone", () => {
    const original = { stringSettings: { language: "es-es" } }

    mergeSessionIntoClientSettings(original, SESSION)

    assert.deepEqual(original, { stringSettings: { language: "es-es" } })
  })
})

describe("mergeSessionIntoClientSettings on a document nobody expects", () => {
  it("spreads an array document into its indices, then adds the session", () => {
    const merged = mergeSessionIntoClientSettings(["a", "b"], SESSION)

    assert.deepEqual(merged, { 0: "a", 1: "b", stringSettings: WRITTEN_SESSION })
  })

  it("spreads a string document into its characters, then adds the session", () => {
    const merged = mergeSessionIntoClientSettings("ab", SESSION)

    assert.deepEqual(merged, { 0: "a", 1: "b", stringSettings: WRITTEN_SESSION })
  })

  it("keeps nothing from a number document", () => {
    assert.deepEqual(mergeSessionIntoClientSettings(42, SESSION), { stringSettings: WRITTEN_SESSION })
  })

  it("keeps nothing from a null document", () => {
    assert.deepEqual(mergeSessionIntoClientSettings(null, SESSION), { stringSettings: WRITTEN_SESSION })
  })

  it("keeps nothing from a boolean document", () => {
    assert.deepEqual(mergeSessionIntoClientSettings(true, SESSION), { stringSettings: WRITTEN_SESSION })
  })

  it("merges into a stringSettings that is an array, since only the document is checked for being one", () => {
    const merged = mergeSessionIntoClientSettings({ stringSettings: ["a"] }, SESSION)

    assert.deepEqual(merged, { stringSettings: { 0: "a", ...WRITTEN_SESSION } })
  })

  it("discards a stringSettings that is not an object at all", () => {
    assert.deepEqual(mergeSessionIntoClientSettings({ stringSettings: "not a section" }, SESSION), { stringSettings: WRITTEN_SESSION })
  })

  it("discards a null stringSettings", () => {
    assert.deepEqual(mergeSessionIntoClientSettings({ stringSettings: null }, SESSION), { stringSettings: WRITTEN_SESSION })
  })
})

describe("writeClientSettingsSession", () => {
  it("writes the merged document back to the same file", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { intSettings: { maxFps: 60 } } })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "written" })
    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.path, SETTINGS_PATH)
    assert.deepEqual(writes[0]?.document, { intSettings: { maxFps: 60 }, stringSettings: WRITTEN_SESSION })
  })

  it("creates the file when the installation has no settings yet", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: undefined })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "written" })
    assert.deepEqual(writes[0]?.document, { stringSettings: WRITTEN_SESSION })
  })

  it("writes nothing when the settings file cannot be read and cannot be set aside either", async () => {
    const { jsonFile, writes, setAsides } = fakeJsonFile({ ok: false, error: "Unexpected token }" })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "unreadable-settings" })
    assert.deepEqual(setAsides, [SETTINGS_PATH], "keeping the file is tried before giving up on it")
    assert.deepEqual(writes, [], "a file that could not be kept must never be written over")
  })

  it("reports a write that did not happen", async () => {
    const { jsonFile } = fakeJsonFile({ ok: true, document: {} }, { ok: false, error: "EACCES" })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "write-failed" })
  })
})

/**
 * Issue #691: a power cut left an installation's settings file as something that is not JSON, and
 * every launch after it stopped on it, with a message that told the player to log in again, which
 * cannot fix a file. The file is now set aside whole and the launch goes on as if it had never been
 * there, so these pin both halves: what is kept, and what happens next.
 */
describe("writeClientSettingsSession when the settings file cannot be read", () => {
  const UNREADABLE: JsonFileReadResult = { ok: false, error: "Unexpected token }" }

  it("sets the file aside, then writes the session into a fresh one", async () => {
    const { jsonFile, writes, setAsides } = fakeJsonFile(UNREADABLE, { ok: true }, { ok: true, name: KEPT_NAME })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "written", setAside: KEPT_NAME })
    assert.deepEqual(setAsides, [SETTINGS_PATH])
    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.path, SETTINGS_PATH)
    assert.deepEqual(writes[0]?.document, { stringSettings: WRITTEN_SESSION }, "exactly what a missing file gets")
  })

  it("sets the file aside before anything is written, since the write would otherwise replace it", async () => {
    const { jsonFile, events } = fakeJsonFile(UNREADABLE, { ok: true }, { ok: true, name: KEPT_NAME })

    await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(events, ["set-aside", "write"])
  })

  it("carries on as with a missing file when the mod folder list is being checked too", async () => {
    const { jsonFile, writes } = fakeJsonFile(UNREADABLE, { ok: true }, { ok: true, name: KEPT_NAME })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION, modPaths: { installationPath: "/data/survival", modsPath: "/data/survival/Mods" } })

    assert.deepEqual(result, { outcome: "written", setAside: KEPT_NAME }, "there is no list to repoint, and nothing is said about one")
    assert.deepEqual(writes[0]?.document, { stringSettings: WRITTEN_SESSION })
  })

  it("refuses, writing nothing, when the file cannot be set aside", async () => {
    const { jsonFile, writes, events } = fakeJsonFile(UNREADABLE, { ok: true }, { ok: false })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "unreadable-settings" })
    assert.deepEqual(writes, [])
    assert.deepEqual(events, ["set-aside"])
  })

  it("still names the kept file when the fresh one then cannot be written", async () => {
    const { jsonFile } = fakeJsonFile(UNREADABLE, { ok: false, error: "ENOSPC" }, { ok: true, name: KEPT_NAME })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "write-failed", setAside: KEPT_NAME })
  })

  it("never sets aside a file it could read, nor one that is not there", async () => {
    for (const read of [
      { ok: true, document: { intSettings: { maxFps: 60 } } },
      { ok: true, document: undefined }
    ] satisfies JsonFileReadResult[]) {
      const { jsonFile, setAsides } = fakeJsonFile(read, { ok: true }, { ok: true, name: KEPT_NAME })

      const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

      assert.deepEqual(result, { outcome: "written" })
      assert.deepEqual(setAsides, [])
    }
  })
})

/**
 * The loop from issue #204: the game refreshes an invalidated session into its
 * own settings file, and the launcher writes the dead one back over it on the
 * next launch, so the player is asked to log in every single time. These pin
 * the side the launcher now takes.
 */
describe("writeClientSettingsSession when the game refreshed the session itself", () => {
  /** What the game leaves behind after asking the player to log in: same account, new key. */
  const GAME_REFRESHED = {
    ...WRITTEN_SESSION,
    mptoken: "game-mp-token",
    sessionkey: "game-session-key",
    sessionsignature: "game-session-signature"
  }

  it("keeps the game's session and hands it back to be adopted", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: GAME_REFRESHED } })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "adopted", secrets: { sessionKey: "game-session-key", sessionSignature: "game-session-signature", mptoken: "game-mp-token" } })
    assert.deepEqual(writes, [], "the game's session must survive the launch it was written before")
  })

  it("adopts a refreshed session that carries no multiplayer token", async () => {
    const { jsonFile } = fakeJsonFile({ ok: true, document: { stringSettings: { ...GAME_REFRESHED, mptoken: null } } })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "adopted", secrets: { sessionKey: "game-session-key", sessionSignature: "game-session-signature", mptoken: null } })
  })

  it("writes ours over a session belonging to another player, uid and all", async () => {
    // Adopting here would leave the launcher showing one account's name while
    // holding another account's key, which is worse than the loop it fixes.
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: { ...GAME_REFRESHED, playeruid: "uid-2", playername: "Someone Else" } } })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "written" })
    assert.deepEqual(stringSettingsOf(writes[0]?.document as Record<string, unknown>), WRITTEN_SESSION)
  })

  it("writes ours when the file carries a session but no uid to attach it to", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: { sessionkey: "orphan-key", sessionsignature: "orphan-signature" } } })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "written" })
    assert.equal(stringSettingsOf(writes[0]?.document as Record<string, unknown>).sessionkey, "session-key")
  })

  it("writes ours when the file's session is too incomplete to store", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: { ...GAME_REFRESHED, sessionsignature: "" } } })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "written" })
    assert.equal(stringSettingsOf(writes[0]?.document as Record<string, unknown>).sessionkey, "session-key")
  })

  it("writes ours, unchanged, when the file already holds our own session", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: { ...WRITTEN_SESSION, language: "es-es" } } })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "written" })
    assert.deepEqual(stringSettingsOf(writes[0]?.document as Record<string, unknown>), { ...WRITTEN_SESSION, language: "es-es" })
  })

  it("writes ours when the file holds every other setting but no session at all", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: { language: "es-es" }, intSettings: { maxFps: 60 } } })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "written" })
    assert.deepEqual(writes[0]?.document, { intSettings: { maxFps: 60 }, stringSettings: { language: "es-es", ...WRITTEN_SESSION } })
  })
})

describe("removeSessionFromClientSettings", () => {
  it("removes exactly the eight session keys and nothing else", () => {
    const result = removeSessionFromClientSettings({ stringSettings: { ...WRITTEN_SESSION, language: "es-es" }, intSettings: { maxFps: 60 } })

    assert.deepEqual(stringSettingsOf(result), { language: "es-es" })
    assert.deepEqual(result.intSettings, { maxFps: 60 })
    for (const key of GAME_SESSION_KEYS) assert.equal(key in stringSettingsOf(result), false, key)
  })

  it("produces an empty stringSettings section when there was nothing but a session", () => {
    const result = removeSessionFromClientSettings({ stringSettings: WRITTEN_SESSION })
    assert.deepEqual(stringSettingsOf(result), {})
  })

  it("is a no-op shape-wise on a document with no session to begin with", () => {
    const result = removeSessionFromClientSettings({ stringSettings: { language: "es-es" } })
    assert.deepEqual(stringSettingsOf(result), { language: "es-es" })
  })

  it("treats a missing or unreadable document as empty rather than throwing", () => {
    assert.deepEqual(removeSessionFromClientSettings(undefined), { stringSettings: {} })
    assert.deepEqual(removeSessionFromClientSettings(null), { stringSettings: {} })
    assert.deepEqual(removeSessionFromClientSettings("not an object"), { stringSettings: {} })
  })

  it("leaves the document it was given alone", () => {
    const original = { stringSettings: { ...WRITTEN_SESSION, language: "es-es" } }
    removeSessionFromClientSettings(original)
    assert.deepEqual(stringSettingsOf(original), { ...WRITTEN_SESSION, language: "es-es" })
  })
})

/**
 * With one saved account, a settings file the launcher could not update was
 * harmless: whatever stale session it held was that same account's own. With
 * more than one, it can be a housemate's, since the game writes their session
 * there directly on their own successful login. This guards the launch path
 * that keeps a locked or unreadable secret store from silently starting the
 * game already signed in as somebody else.
 */
describe("clearForeignClientSettingsSession", () => {
  const OUR_UID = "uid-1"
  const FOREIGN_SESSION = { ...WRITTEN_SESSION, playeruid: "uid-housemate", playername: "Housemate" }

  it("clears a session that belongs to a different player", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: { ...FOREIGN_SESSION, language: "es-es" }, intSettings: { maxFps: 60 } } })

    const result = await clearForeignClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, playerUid: OUR_UID })

    assert.deepEqual(result, { outcome: "cleared" })
    assert.equal(writes.length, 1)
    const written = writes[0]?.document as Record<string, unknown>
    assert.deepEqual(stringSettingsOf(written), { language: "es-es" })
    assert.deepEqual(written.intSettings, { maxFps: 60 }, "everything else in the file survives")
  })

  it("leaves a file that already holds our own session alone", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: WRITTEN_SESSION } })

    const result = await clearForeignClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, playerUid: OUR_UID })

    assert.deepEqual(result, { outcome: "not-foreign" })
    assert.deepEqual(writes, [])
  })

  it("leaves a file with no session in it alone", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: { language: "es-es" } } })

    const result = await clearForeignClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, playerUid: OUR_UID })

    assert.deepEqual(result, { outcome: "not-foreign" })
    assert.deepEqual(writes, [])
  })

  it("leaves an entirely empty settings file alone", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: undefined })

    const result = await clearForeignClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, playerUid: OUR_UID })

    assert.deepEqual(result, { outcome: "not-foreign" })
    assert.deepEqual(writes, [])
  })

  it("reports the settings file as unreadable rather than guessing when it cannot be set aside either", async () => {
    const { jsonFile, writes, setAsides } = fakeJsonFile({ ok: false, error: "Unexpected token }" })

    const result = await clearForeignClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, playerUid: OUR_UID })

    assert.deepEqual(result, { outcome: "unreadable-settings" })
    assert.deepEqual(setAsides, [SETTINGS_PATH])
    assert.deepEqual(writes, [])
  })

  /**
   * Issue #691 again, from the side that has no session of its own to write. The file is set
   * aside and nothing takes its place: no file carries no session, which is what this function
   * exists to guarantee, so the launch goes on with none.
   */
  it("sets an unreadable file aside and writes nothing, since no file holds no foreign session", async () => {
    const { jsonFile, writes, setAsides } = fakeJsonFile({ ok: false, error: "Unexpected token }" }, { ok: true }, { ok: true, name: KEPT_NAME })

    const result = await clearForeignClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, playerUid: OUR_UID })

    assert.deepEqual(result, { outcome: "not-foreign", setAside: KEPT_NAME })
    assert.deepEqual(setAsides, [SETTINGS_PATH])
    assert.deepEqual(writes, [])
  })

  it("never sets aside a file it could read, nor one that is not there", async () => {
    for (const read of [
      { ok: true, document: { stringSettings: FOREIGN_SESSION } },
      { ok: true, document: undefined }
    ] satisfies JsonFileReadResult[]) {
      const { jsonFile, setAsides } = fakeJsonFile(read, { ok: true }, { ok: true, name: KEPT_NAME })

      await clearForeignClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, playerUid: OUR_UID })

      assert.deepEqual(setAsides, [])
    }
  })

  it("reports a clear that did not land", async () => {
    const { jsonFile } = fakeJsonFile({ ok: true, document: { stringSettings: FOREIGN_SESSION } }, { ok: false, error: "EACCES" })

    const result = await clearForeignClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, playerUid: OUR_UID })

    assert.deepEqual(result, { outcome: "write-failed" })
  })

  it("never writes a session of its own; that stays writeClientSettingsSession's job", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: { stringSettings: FOREIGN_SESSION } })

    await clearForeignClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, playerUid: OUR_UID })

    const written = writes[0]?.document as Record<string, unknown>
    for (const key of GAME_SESSION_KEYS) assert.equal(key in stringSettingsOf(written), false, key)
  })
})
