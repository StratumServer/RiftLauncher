import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { CLIENT_SETTINGS_FILE_NAME, writeClientSettingsSession } from "../../../src/domain/account/clientSettings"
import type { AccountSessionFields } from "../../../src/domain/account/clientSettings"
import { repointModPaths } from "../../../src/domain/account/modPaths"
import type { ModPathsTarget } from "../../../src/domain/account/modPaths"
import type { JsonFile, JsonFileReadResult, JsonFileWriteResult } from "../../../src/domain/ports"

const INSTALLATION_PATH = "/data/survival"
const SETTINGS_PATH = `${INSTALLATION_PATH}/${CLIENT_SETTINGS_FILE_NAME}`
const TARGET: ModPathsTarget = { installationPath: INSTALLATION_PATH, modsPath: `${INSTALLATION_PATH}/Mods` }

/** What the game writes into a data folder it was copied out of. */
const FOREIGN_DEFAULT = ["Mods", "/home/player/.config/VintagestoryData/Mods"]

/** A whole settings file, of the shape the game keeps one in. */
function documentWith(modPaths: unknown): Record<string, unknown> {
  return {
    stringSettings: { language: "es-es", playername: "Player One" },
    intSettings: { maxFps: 60 },
    floatSettings: { musicLevel: 0.5 },
    boolSettings: { fullscreen: true },
    stringListSettings: { modPaths, disabledMods: ["broken"] }
  }
}

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

function modPathsOf(document: unknown): unknown {
  return ((document as Record<string, unknown>).stringListSettings as Record<string, unknown>).modPaths
}

function fakeJsonFile(read: JsonFileReadResult, write: JsonFileWriteResult = { ok: true }): { jsonFile: JsonFile; writes: { path: string; document: unknown }[] } {
  const writes: { path: string; document: unknown }[] = []

  return {
    writes,
    jsonFile: {
      read: async () => read,
      write: async (path: string, document: unknown): Promise<JsonFileWriteResult> => {
        writes.push({ path, document })
        return write
      }
    }
  }
}

describe("repointModPaths on the list the game writes itself", () => {
  it("repoints an absolute entry that names another data folder", () => {
    const result = repointModPaths(documentWith(FOREIGN_DEFAULT), TARGET)

    assert.equal(result.outcome, "repointed")
    assert.deepEqual(modPathsOf(result.document), ["Mods", "/data/survival/Mods"])
  })

  it("moves nothing else in the document", () => {
    const result = repointModPaths(documentWith(FOREIGN_DEFAULT), TARGET)

    assert.deepEqual(result.document, {
      ...documentWith(["Mods", "/data/survival/Mods"])
    })
  })

  it("leaves the document it was given alone", () => {
    const original = documentWith([...FOREIGN_DEFAULT])
    repointModPaths(original, TARGET)
    assert.deepEqual(modPathsOf(original), FOREIGN_DEFAULT)
  })

  it("keeps the absolute entry where it stood when the game wrote it first", () => {
    const result = repointModPaths(documentWith([FOREIGN_DEFAULT[1], "Mods"]), TARGET)

    assert.equal(result.outcome, "repointed")
    assert.deepEqual(modPathsOf(result.document), ["/data/survival/Mods", "Mods"])
  })
})

describe("repointModPaths on a list already pointing at this installation", () => {
  it("hands back the very same document when the absolute entry is our own Mods folder", () => {
    const document = documentWith(["Mods", "/data/survival/Mods"])
    const result = repointModPaths(document, TARGET)

    assert.equal(result.outcome, "unchanged")
    assert.equal(result.document, document)
  })

  it("hands back the very same document for a folder deeper inside the installation", () => {
    const document = documentWith(["Mods", "/data/survival/extra/Mods"])
    const result = repointModPaths(document, TARGET)

    assert.equal(result.outcome, "unchanged")
    assert.equal(result.document, document)
  })

  it("does not mistake a sibling folder with the same prefix for the installation", () => {
    const result = repointModPaths(documentWith(["Mods", "/data/survival2/Mods"]), TARGET)
    assert.equal(result.outcome, "repointed")
  })
})

/**
 * Windows file systems do not distinguish case, and the game and the launcher
 * do not agree on which separator to write, so a file that already points at
 * this installation must be recognised through both.
 */
describe("repointModPaths on Windows paths", () => {
  const WINDOWS_TARGET: ModPathsTarget = { installationPath: "C:\\Users\\Player\\AppData\\Roaming\\VintagestoryData", modsPath: "C:\\Users\\Player\\AppData\\Roaming\\VintagestoryData\\Mods" }

  it("reads a backslash path and a forward slash path as the same folder", () => {
    const document = documentWith(["Mods", "C:/Users/Player/AppData/Roaming/VintagestoryData/Mods"])
    const result = repointModPaths(document, WINDOWS_TARGET)

    assert.equal(result.outcome, "unchanged")
    assert.equal(result.document, document)
  })

  it("reads a differently cased path as the same folder", () => {
    const document = documentWith(["Mods", "c:\\users\\player\\appdata\\roaming\\vintagestorydata\\mods"])
    const result = repointModPaths(document, WINDOWS_TARGET)

    assert.equal(result.outcome, "unchanged")
    assert.equal(result.document, document)
  })

  it("still repoints a Windows path naming a different data folder", () => {
    const result = repointModPaths(documentWith(["Mods", "D:\\Games\\OtherLauncher\\Data\\mods"]), WINDOWS_TARGET)

    assert.equal(result.outcome, "repointed")
    assert.deepEqual(modPathsOf(result.document), ["Mods", "C:\\Users\\Player\\AppData\\Roaming\\VintagestoryData\\Mods"])
  })
})

/**
 * Every list that is not the one the game writes on its own is somebody's
 * deliberate setup. Repointing those would take mod folders off the player's
 * list on their behalf.
 */
describe("repointModPaths on a list the player customised", () => {
  const CUSTOM_LISTS: [string, unknown][] = [
    ["a third mod folder", ["Mods", "/home/player/.config/VintagestoryData/Mods", "/mnt/big/SharedMods"]],
    ["one entry only", ["/home/player/.config/VintagestoryData/Mods"]],
    ["no relative entry", ["/home/player/.config/VintagestoryData/Mods", "/mnt/big/SharedMods"]],
    ["an absolute entry that is not a Mods folder", ["Mods", "/home/player/.config/VintagestoryData/Addons"]],
    ["an empty list", []],
    ["entries that are not strings", ["Mods", 42]],
    ["something that is not a list at all", "/home/player/.config/VintagestoryData/Mods"]
  ]

  for (const [name, list] of CUSTOM_LISTS)
    it(`leaves ${name} exactly as found`, () => {
      const document = documentWith(list)
      const result = repointModPaths(document, TARGET)

      assert.equal(result.outcome, "left-as-found")
      assert.equal(result.document, document)
    })
})

describe("repointModPaths on a file with no list to repoint", () => {
  it("says nothing about a document carrying no stringListSettings section", () => {
    const document = { stringSettings: { language: "es-es" } }
    const result = repointModPaths(document, TARGET)

    assert.equal(result.outcome, "unchanged")
    assert.equal(result.document, document)
  })

  it("says nothing about a section carrying no modPaths key", () => {
    const document = { stringListSettings: { disabledMods: ["broken"] } }
    const result = repointModPaths(document, TARGET)

    assert.equal(result.outcome, "unchanged")
    assert.equal(result.document, document)
  })

  it("says nothing about a settings file that is not there, or is not an object", () => {
    for (const document of [undefined, null, "not an object", ["not an object"]]) {
      const result = repointModPaths(document, TARGET)
      assert.equal(result.outcome, "unchanged")
      assert.equal(result.document, document)
    }
  })
})

describe("writeClientSettingsSession with an installation to check the mod folder list against", () => {
  it("repoints the list in the same write that installs the session", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: documentWith(FOREIGN_DEFAULT) })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION, modPaths: TARGET })

    assert.deepEqual(result, { outcome: "written", modPaths: "repointed" })
    assert.equal(writes.length, 1)
    assert.deepEqual(modPathsOf(writes[0]?.document), ["Mods", "/data/survival/Mods"])
  })

  it("reports a customised list without touching it", async () => {
    const custom = ["Mods", "/home/player/.config/VintagestoryData/Mods", "/mnt/big/SharedMods"]
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: documentWith(custom) })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION, modPaths: TARGET })

    assert.deepEqual(result, { outcome: "written", modPaths: "left-as-found" })
    assert.deepEqual(modPathsOf(writes[0]?.document), custom)
  })

  it("says nothing when the list already points at this installation", async () => {
    const { jsonFile } = fakeJsonFile({ ok: true, document: documentWith(["Mods", "/data/survival/Mods"]) })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION, modPaths: TARGET })

    assert.deepEqual(result, { outcome: "written" })
  })

  it("writes the repointed list even when the game's own session wins, and keeps that session", async () => {
    const gameRefreshed = {
      ...documentWith(FOREIGN_DEFAULT),
      stringSettings: { playeruid: "uid-1", sessionkey: "game-session-key", sessionsignature: "game-session-signature", mptoken: "game-mp-token" }
    }
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: gameRefreshed })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION, modPaths: TARGET })

    assert.deepEqual(result, { outcome: "adopted", secrets: { sessionKey: "game-session-key", sessionSignature: "game-session-signature", mptoken: "game-mp-token" }, modPaths: "repointed" })
    assert.equal(writes.length, 1)
    assert.deepEqual(modPathsOf(writes[0]?.document), ["Mods", "/data/survival/Mods"])
    assert.deepEqual((writes[0]?.document as Record<string, unknown>).stringSettings, gameRefreshed.stringSettings)
  })

  it("writes nothing when the game's session wins and the list needs no repointing", async () => {
    const gameRefreshed = {
      ...documentWith(["Mods", "/data/survival/Mods"]),
      stringSettings: { playeruid: "uid-1", sessionkey: "game-session-key", sessionsignature: "game-session-signature", mptoken: "game-mp-token" }
    }
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: gameRefreshed })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION, modPaths: TARGET })

    assert.equal(result.outcome, "adopted")
    assert.deepEqual(writes, [], "the game's session must survive the launch it was written before")
  })

  it("looks at nothing at all when no installation is handed in", async () => {
    const { jsonFile, writes } = fakeJsonFile({ ok: true, document: documentWith(FOREIGN_DEFAULT) })

    const result = await writeClientSettingsSession({ jsonFile }, { settingsPath: SETTINGS_PATH, session: SESSION })

    assert.deepEqual(result, { outcome: "written" })
    assert.deepEqual(modPathsOf(writes[0]?.document), FOREIGN_DEFAULT)
  })
})
