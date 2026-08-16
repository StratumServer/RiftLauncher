import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { parseModInfo } from "../../../src/domain/mods/modinfo"
import type { ModInfo } from "../../../src/domain/mods/modinfo"

/** The three fields without which nothing downstream works, spelled the documented way. */
const MINIMAL = { modid: "primitivesurvival", name: "Primitive Survival", version: "3.5.1" }

/** Reads a file that is expected to hold up, and fails loudly when it does not. */
function parsed(text: string): ModInfo {
  const result = parseModInfo(text)
  assert.equal(result.ok, true, `expected ${text} to describe a mod`)
  if (!result.ok) throw new Error("unreachable")
  return result.info
}

describe("parseModInfo required fields", () => {
  it("reads the three fields the launcher keys everything off", () => {
    const info = parsed(JSON.stringify(MINIMAL))

    assert.equal(info.modid, "primitivesurvival")
    assert.equal(info.name, "Primitive Survival")
    assert.equal(info.version, "3.5.1")
  })

  it("names a file missing an identifier apart from one that will not parse", () => {
    assert.deepEqual(parseModInfo(JSON.stringify({ name: "Nameless", version: "1.0.0" })), { ok: false, problem: "modinfo-incomplete" })
    assert.deepEqual(parseModInfo(JSON.stringify({ modid: "nameless", version: "1.0.0" })), { ok: false, problem: "modinfo-incomplete" })
    assert.deepEqual(parseModInfo(JSON.stringify({ modid: "nameless", name: "Nameless" })), { ok: false, problem: "modinfo-incomplete" })
  })

  it("refuses an empty identifier rather than listing a mod with no name", () => {
    assert.deepEqual(parseModInfo(JSON.stringify({ ...MINIMAL, name: "" })), { ok: false, problem: "modinfo-incomplete" })
  })

  it("drops a field that arrived as the wrong type instead of coercing it", () => {
    assert.deepEqual(parseModInfo(JSON.stringify({ ...MINIMAL, version: 3 })), { ok: false, problem: "modinfo-incomplete" })
  })

  it("refuses a value carrying a NUL, which would travel on into paths and logs", () => {
    assert.deepEqual(parseModInfo(JSON.stringify({ ...MINIMAL, modid: `prim${String.fromCharCode(0)}survival` })), { ok: false, problem: "modinfo-incomplete" })
  })

  it("refuses an identifier longer than an identifier can be", () => {
    assert.deepEqual(parseModInfo(JSON.stringify({ ...MINIMAL, modid: "m".repeat(257) })), { ok: false, problem: "modinfo-incomplete" })
    assert.equal(parseModInfo(JSON.stringify({ ...MINIMAL, modid: "m".repeat(256) })).ok, true)
  })
})

describe("parseModInfo key casing", () => {
  it("reads the identifier however its author cased it", () => {
    for (const key of ["modid", "Modid", "ModID", "modID", "modId", "MODID"]) {
      const info = parsed(JSON.stringify({ [key]: "cased", name: "Cased", version: "1.0.0" }))
      assert.equal(info.modid, "cased", `expected ${key} to be read as the identifier`)
    }
  })

  it("reads every other field case insensitively too", () => {
    const info = parsed(JSON.stringify({ ...MINIMAL, Description: "A mod", Side: "Universal", Type: "Code", Authors: ["Someone"], Contributors: ["Someone Else"] }))

    assert.equal(info.description, "A mod")
    assert.equal(info.side, "Universal")
    assert.equal(info.type, "Code")
    assert.deepEqual(info.authors, ["Someone"])
    assert.deepEqual(info.contributors, ["Someone Else"])
  })

  it("prefers the exact spelling when a file carries the same key twice", () => {
    assert.equal(parsed(JSON.stringify({ ModID: "shouted", modid: "exact", name: "Twice", version: "1.0.0" })).modid, "exact")
  })
})

describe("parseModInfo syntax tolerance", () => {
  it("accepts the comments and trailing commas the game itself accepts", () => {
    const info = parsed(`{
      // the mod's own identifier
      modid: "tolerant",
      name: 'Tolerant',
      version: "1.0.0", /* still fine */
    }`)

    assert.equal(info.modid, "tolerant")
    assert.equal(info.name, "Tolerant")
  })

  it("names text that will not parse at all", () => {
    assert.deepEqual(parseModInfo("{ modid: "), { ok: false, problem: "modinfo-invalid" })
    assert.deepEqual(parseModInfo(""), { ok: false, problem: "modinfo-invalid" })
  })

  it("names a file that parses but describes something other than an object", () => {
    assert.deepEqual(parseModInfo("[1, 2, 3]"), { ok: false, problem: "modinfo-invalid" })
    assert.deepEqual(parseModInfo('"just a string"'), { ok: false, problem: "modinfo-invalid" })
    assert.deepEqual(parseModInfo("null"), { ok: false, problem: "modinfo-invalid" })
  })
})

describe("parseModInfo optional fields", () => {
  it("leaves out what the file does not carry", () => {
    const info = parsed(JSON.stringify(MINIMAL))

    assert.equal(info.description, undefined)
    assert.equal(info.side, undefined)
    assert.equal(info.authors, undefined)
    assert.equal(info.contributors, undefined)
    assert.equal(info.type, undefined)
  })

  it("keeps an author list whole", () => {
    assert.deepEqual(parsed(JSON.stringify({ ...MINIMAL, authors: ["Alice", "Bob"] })).authors, ["Alice", "Bob"])
  })

  it("drops an author list with an unusable entry rather than showing half of it", () => {
    assert.equal(parsed(JSON.stringify({ ...MINIMAL, authors: ["Alice", 42] })).authors, undefined)
  })

  it("drops a list longer than any real credit list", () => {
    assert.equal(parsed(JSON.stringify({ ...MINIMAL, contributors: Array.from({ length: 257 }, (_, index) => `C${index}`) })).contributors, undefined)
  })

  it("reads the single-name shorthand some files use instead of a list", () => {
    assert.deepEqual(parsed(JSON.stringify({ ...MINIMAL, author: "Solo" })).authors, ["Solo"])
  })

  it("prefers the list when a file carries both spellings", () => {
    assert.deepEqual(parsed(JSON.stringify({ ...MINIMAL, author: "Solo", authors: ["Alice", "Bob"] })).authors, ["Alice", "Bob"])
  })

  it("ignores an authors field that is not a list at all", () => {
    assert.equal(parsed(JSON.stringify({ ...MINIMAL, authors: { first: "Alice" } })).authors, undefined)
  })
})
