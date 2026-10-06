import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { assertModConfigKey, diagnoseModConfigKey, findCollidingModConfigKeys, isValidModConfigKey, showDefaultIgnorables } from "../../../src/domain/mods/modConfigs"

describe("modConfigs domain", () => {
  describe("assertModConfigKey and isValidModConfigKey", () => {
    it("accepts valid mod config names", () => {
      const validNames = ["RoomSize.json", "ConfigureEverything/Client/RoomSize.json", "ROOM.JSON", "a-b_c.1.json", ".json"]
      for (const name of validNames) {
        assert.equal(assertModConfigKey(name), name)
        assert.equal(isValidModConfigKey(name), true)
      }
    })

    it("refuses names that do not end in .json", () => {
      assert.throws(() => assertModConfigKey("config.txt"), /must name a \.json file/)
      assert.equal(isValidModConfigKey("config.txt"), false)
    })

    it("refuses names with forbidden characters or reserved base names", () => {
      const invalidNames = [
        "what?.json",
        "a*b.json",
        "a:b.json",
        "a<b.json",
        "a|b.json",
        'a"b.json',
        "nul.json",
        "NUL.json",
        "Client/nul/room.json",
        "com1.json",
        "COM¹.json",
        "CLOCK$.json",
        "aux.txt.json",
        "trailing .json",
        "trailing..json",
        "ConfigureEverything/Client/RoomSize.json\u0000"
      ]
      for (const name of invalidNames) {
        assert.throws(() => assertModConfigKey(name), /Invalid mod config key/)
        assert.equal(isValidModConfigKey(name), false)
      }
    })

    it("keeps traversal, whole-key and per-segment Windows bounds pinned", () => {
      const invalidNames = ["..\\clientsettings.json", `${"a".repeat(251)}.json`, `${"a".repeat(255)}/${"b".repeat(251)}/.json`, "a\u0001Ab.json", "a\u007fb.json"]

      for (const name of invalidNames) {
        assert.throws(() => assertModConfigKey(name), /Invalid mod config key/)
        assert.equal(isValidModConfigKey(name), false)
      }
    })

    it("refuses bidi controls and zero-width characters that disguise a name", () => {
      const bidiAndZeroWidth = [
        "safe\u202Egnp.json",
        "\u202Eevil.json",
        "folder\u202A/config.json",
        "bidi\u061C.json",
        "isolate\u2066.json",
        "zero\u200Bwidth.json",
        "non\u200Cjoiner.json",
        "joiner\u200D.json",
        "word\u2060joiner.json",
        "bom\uFEFF.json",
        "mongolian\u180Espace.json"
      ]

      for (const name of bidiAndZeroWidth) {
        assert.throws(() => assertModConfigKey(name), /Invalid mod config key/)
        assert.equal(isValidModConfigKey(name), false)
      }
    })

    it("refuses representative default-ignorable characters in file and folder segments", () => {
      const hiddenCharacters = ["\u034F", "\u115F", "\u17B4", "\u180B", "\u180F", "\u2065", "\u3164", "\uFE0F", "\uFFA0", "\uFFF0", "\u{E0000}", "\u{E0080}", "\u{E0100}", "\u{E0FFF}"]

      for (const hidden of hiddenCharacters) {
        assert.throws(() => assertModConfigKey(`Client/config${hidden}.json`), /Invalid mod config key/)
        assert.throws(() => assertModConfigKey(`Client/Sub${hidden}/config.json`), /Invalid mod config key/)
      }
    })
  })

  describe("showDefaultIgnorables", () => {
    it("makes hidden code points in a name visible as hex tags", () => {
      assert.equal(showDefaultIgnorables("config\u034F.json"), "config<U+034F>.json")
      assert.equal(showDefaultIgnorables("zero\u200Bwidth.json"), "zero<U+200B>width.json")
      assert.equal(showDefaultIgnorables("normal.json"), "normal.json")
    })
  })

  describe("findCollidingModConfigKeys", () => {
    it("returns empty set when all names have distinct case-folded spellings", () => {
      const names = ["foo.json", "bar.json", "sub/baz.json"]
      const collisions = findCollidingModConfigKeys(names)
      assert.equal(collisions.size, 0)
    })

    it("identifies keys that differ only in letter case", () => {
      const names = ["AutoMap.json", "automap.json", "other.json"]
      const collisions = findCollidingModConfigKeys(names)
      assert.equal(collisions.size, 1)
      assert.equal(collisions.has("automap.json"), true)
      assert.equal(collisions.has("other.json"), false)
    })

    it("identifies multiple collisions across different names", () => {
      const names = ["A.json", "a.json", "B.json", "b.json", "c.json"]
      const collisions = findCollidingModConfigKeys(names)
      assert.equal(collisions.size, 2)
      assert.equal(collisions.has("a.json"), true)
      assert.equal(collisions.has("b.json"), true)
      assert.equal(collisions.has("c.json"), false)
    })
  })

  describe("diagnoseModConfigKey", () => {
    it("returns undefined for valid, unique config keys", () => {
      const colliding = new Set<string>()
      assert.equal(diagnoseModConfigKey("valid.json", colliding), undefined)
    })

    it("returns hidden-character before bad-name for keys containing default ignorables", () => {
      const colliding = new Set<string>()
      assert.equal(diagnoseModConfigKey("config\u034F.json", colliding), "hidden-character")
      assert.equal(diagnoseModConfigKey("bad:name\u200B.json", colliding), "hidden-character")
    })

    it("returns bad-name when the key fails Windows or format validation", () => {
      const colliding = new Set<string>(["bad:name.json"])
      assert.equal(diagnoseModConfigKey("bad:name.json", colliding), "bad-name")
      assert.equal(diagnoseModConfigKey("con.json", new Set<string>()), "bad-name")
    })

    it("returns collides when the key has a case collision with another config", () => {
      const colliding = new Set<string>(["automap.json"])
      assert.equal(diagnoseModConfigKey("AutoMap.json", colliding), "collides")
      assert.equal(diagnoseModConfigKey("automap.json", colliding), "collides")
    })
  })
})
