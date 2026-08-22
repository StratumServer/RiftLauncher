import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  type ModDbModDetail,
  newestReleaseFileId,
  parseAuthorsResponse,
  parseGameVersionsResponse,
  parseModDetailResponse,
  parseModListResponse,
  parseTagsResponse
} from "../../../src/domain/mods/moddb"

describe("v1 envelope handling", () => {
  it("names an application error carried by a real HTTP 200, the ModDB's core quirk", () => {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: "404" }))
    assert.deepEqual(result, { ok: false, reason: "api-error", statusCode: "404" })
  })

  it("does not treat a numeric statuscode as success, since the API always sends a string", () => {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: 200, mod: { modid: 1, name: "Numeric" } }))
    assert.equal(result.ok, false)
  })

  it("names text that never was JSON", () => {
    const result = parseModDetailResponse("{ statuscode: ")
    assert.deepEqual(result, { ok: false, reason: "malformed-response" })
  })

  it("names a JSON document that is not an object", () => {
    assert.deepEqual(parseModDetailResponse("[1, 2, 3]"), { ok: false, reason: "malformed-response" })
    assert.deepEqual(parseModDetailResponse('"just a string"'), { ok: false, reason: "malformed-response" })
    assert.deepEqual(parseModDetailResponse("null"), { ok: false, reason: "malformed-response" })
  })

  it("names a success envelope whose expected field is missing, carrying the statuscode along", () => {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: "200" }))
    assert.deepEqual(result, { ok: false, reason: "malformed-response", statusCode: "200" })
  })
})

describe("parseModListResponse", () => {
  it("reads a mod list on success", () => {
    const raw = JSON.stringify({
      statuscode: "200",
      mods: [{ modid: 792, assetid: 3829, name: "BetterRuins", author: "NiclAss", modidstrs: ["betterruins"], tags: ["Exploration"] }]
    })

    const result = parseModListResponse(raw)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")

    assert.equal(result.payload.length, 1)
    assert.equal(result.payload[0]?.modid, 792)
    assert.equal(result.payload[0]?.name, "BetterRuins")
    assert.deepEqual(result.payload[0]?.modidstrs, ["betterruins"])
  })

  it("cleans the PHP empty-array-as-single-blank-string quirk on modidstrs and tags", () => {
    const raw = JSON.stringify({ statuscode: "200", mods: [{ modid: 1, name: "NoTags", modidstrs: [""], tags: [""] }] })

    const result = parseModListResponse(raw)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")

    assert.deepEqual(result.payload[0]?.modidstrs, [])
    assert.deepEqual(result.payload[0]?.tags, [])
  })

  it("drops an entry with no usable modid or name rather than voiding the whole list", () => {
    const raw = JSON.stringify({
      statuscode: "200",
      mods: [{ modid: 1, name: "Good" }, { modid: "not-a-number", name: "BadId" }, { modid: 2, name: "" }, { name: "NoId" }, "not even an object"]
    })

    const result = parseModListResponse(raw)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")

    assert.deepEqual(
      result.payload.map((mod) => mod.name),
      ["Good"]
    )
  })

  it("names a mods field that is not an array as malformed", () => {
    const result = parseModListResponse(JSON.stringify({ statuscode: "200", mods: "not a list" }))
    assert.deepEqual(result, { ok: false, reason: "malformed-response", statusCode: "200" })
  })

  it("accepts an empty catalog as a valid result, not a malformed one", () => {
    const result = parseModListResponse(JSON.stringify({ statuscode: "200", mods: [] }))
    assert.deepEqual(result, { ok: true, payload: [] })
  })

  it("names api-error before ever looking at the mods field", () => {
    const result = parseModListResponse(JSON.stringify({ statuscode: "500", mods: "not even a list" }))
    assert.deepEqual(result, { ok: false, reason: "api-error", statusCode: "500" })
  })
})

describe("parseModDetailResponse", () => {
  it("reads a mod detail on success, carrying every other field through untouched", () => {
    const raw = JSON.stringify({ statuscode: "200", mod: { modid: 1783, name: "Config lib", releases: [{ releaseid: 1, modversion: "1.12.0" }] } })

    const result = parseModDetailResponse(raw)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")

    assert.equal(result.payload.modid, 1783)
    assert.equal(result.payload.name, "Config lib")
    assert.deepEqual(result.payload["releases"], [{ releaseid: 1, modversion: "1.12.0" }])
  })

  it("names a mod field that is not an object as malformed", () => {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: "200", mod: "not an object" }))
    assert.deepEqual(result, { ok: false, reason: "malformed-response", statusCode: "200" })
  })

  it("names a mod with a wrongly typed modid as malformed", () => {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: "200", mod: { modid: "1783", name: "Config lib" } }))
    assert.deepEqual(result, { ok: false, reason: "malformed-response", statusCode: "200" })
  })

  it("names a mod with a blank name as malformed", () => {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: "200", mod: { modid: 1783, name: "   " } }))
    assert.deepEqual(result, { ok: false, reason: "malformed-response", statusCode: "200" })
  })

  it("names a mod with no releases field as malformed, since the install popup maps it", () => {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: "200", mod: { modid: 1783, name: "Config lib" } }))
    assert.deepEqual(result, { ok: false, reason: "malformed-response", statusCode: "200" })
  })

  it("names a mod whose releases is not an array as malformed", () => {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: "200", mod: { modid: 1783, name: "Config lib", releases: "none" } }))
    assert.deepEqual(result, { ok: false, reason: "malformed-response", statusCode: "200" })
  })
})

describe("newestReleaseFileId", () => {
  function detail(releases: unknown[]): ModDbModDetail {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: "200", mod: { modid: 11016, name: "RiftLauncher", releases } }))
    if (!result.ok) throw new Error("unreachable")
    return result.payload
  }

  it("reads the file id off the newest release, which the API serves first", () => {
    assert.equal(
      newestReleaseFileId(
        detail([
          { releaseid: 9, fileid: 116745 },
          { releaseid: 8, fileid: 100000 }
        ])
      ),
      116745
    )
  })

  it("answers undefined for a listing with no releases at all", () => {
    assert.equal(newestReleaseFileId(detail([])), undefined)
  })

  it("refuses a file id that is not a usable positive integer, since it ends up in a URL", () => {
    for (const fileid of ["116745", 0, -3, 1.5, Number.MAX_SAFE_INTEGER + 2, null, undefined]) {
      assert.equal(newestReleaseFileId(detail([{ releaseid: 9, fileid }])), undefined, String(fileid))
    }

    assert.equal(newestReleaseFileId(detail(["not a release"])), undefined)
  })
})

describe("parseAuthorsResponse", () => {
  it("reads authors on success", () => {
    const result = parseAuthorsResponse(JSON.stringify({ statuscode: "200", authors: [{ userid: 29859, name: "Rennorb" }] }))
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.deepEqual(result.payload, [{ userid: 29859, name: "Rennorb" }])
  })

  it("drops an entry missing its id or name", () => {
    const raw = JSON.stringify({ statuscode: "200", authors: [{ userid: 1, name: "Has Both" }, { name: "No Id" }, { userid: 2, name: "" }] })

    const result = parseAuthorsResponse(raw)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.deepEqual(
      result.payload.map((author) => author.name),
      ["Has Both"]
    )
  })

  it("drops an entry that is not an object at all", () => {
    const raw = JSON.stringify({ statuscode: "200", authors: ["just a string", { userid: 1, name: "Real" }] })

    const result = parseAuthorsResponse(raw)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.deepEqual(
      result.payload.map((author) => author.name),
      ["Real"]
    )
  })

  it("drops an entry whose name is present but not a string", () => {
    const raw = JSON.stringify({ statuscode: "200", authors: [{ userid: 1, name: 12345 }] })

    const result = parseAuthorsResponse(raw)
    assert.deepEqual(result, { ok: true, payload: [] })
  })
})

describe("parseGameVersionsResponse", () => {
  it("accepts a numeric tagid, unlike tags[].tagid which is a string", () => {
    const raw = JSON.stringify({ statuscode: "200", gameversions: [{ tagid: -281492156858370, name: "1.5.8", color: "#CCCCCC" }] })

    const result = parseGameVersionsResponse(raw)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.equal(result.payload[0]?.name, "1.5.8")
    assert.equal(result.payload[0]?.["tagid"], -281492156858370)
  })

  it("names a gameversions field that is not an array as malformed", () => {
    const result = parseGameVersionsResponse(JSON.stringify({ statuscode: "200", gameversions: null }))
    assert.deepEqual(result, { ok: false, reason: "malformed-response", statusCode: "200" })
  })
})

describe("parseTagsResponse", () => {
  it("reads tags on success", () => {
    const raw = JSON.stringify({ statuscode: "200", tags: [{ tagid: "467", name: "Absolute Cinema", color: "#92C96AFF" }] })

    const result = parseTagsResponse(raw)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.equal(result.payload[0]?.name, "Absolute Cinema")
  })
})
