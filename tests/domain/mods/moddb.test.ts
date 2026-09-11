import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  type ModDbModDetail,
  modDescriptionParagraphs,
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
    const raw = JSON.stringify({
      statuscode: "200",
      mod: { modid: 1783, name: "Config lib", logofile: "https://moddbcdn.vintagestory.at/config.png", releases: [{ releaseid: 1, modversion: "1.12.0" }] }
    })

    const result = parseModDetailResponse(raw)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")

    assert.equal(result.payload.modid, 1783)
    assert.equal(result.payload.name, "Config lib")
    assert.equal(result.payload.logofile, "https://moddbcdn.vintagestory.at/config.png")
    assert.deepEqual(result.payload["releases"], [{ releaseid: 1, modversion: "1.12.0", tags: [] }])
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

/**
 * Issue #370: the ModDB served Vanilla Variants with a `null` among its tags, and the first render
 * of Manage Mods died on it. The hotfix taught the installed filters to survive that. These pin the
 * same shapes at the boundary instead, so that no reader downstream has to know about them.
 */
describe("parseModDetailResponse: shapes the ModDB actually sends", () => {
  function detailOf(mod: unknown): ModDbModDetail {
    const result = parseModDetailResponse(JSON.stringify({ statuscode: "200", mod }))
    if (!result.ok) throw new Error("unreachable")
    return result.payload
  }

  it("keeps a null out of the mod's own tags, the Vanilla Variants payload that took the page down", () => {
    const detail = detailOf({ modid: 1, name: "Vanilla Variants", tags: ["Cosmetics", "Crafting", "Storage", null], releases: [] })
    assert.deepEqual(detail.tags, ["Cosmetics", "Crafting", "Storage"])
  })

  it("reads a missing or wrongly typed mod tags field as no tags at all", () => {
    assert.deepEqual(detailOf({ modid: 1, name: "No Tags", releases: [] }).tags, [])
    assert.deepEqual(detailOf({ modid: 1, name: "Odd Tags", tags: "Storage", releases: [] }).tags, [])
  })

  it("drops a release that is not an object, which every consumer dereferences unchecked", () => {
    const detail = detailOf({ modid: 1, name: "Nulled", releases: [null, { releaseid: 2, modversion: "1.1.0" }, "not a release"] })
    assert.deepEqual(
      detail.releases.map((release) => release["releaseid"]),
      [2]
    )
  })

  it("keeps a null out of a release's tags, which reach evaluateModCompatibility raw", () => {
    const detail = detailOf({
      modid: 1,
      name: "Tagged",
      releases: [
        { modversion: "1.1.0", tags: ["1.21.0", null] },
        { modversion: "1.0.0", tags: null }
      ]
    })
    assert.deepEqual(
      detail.releases.map((release) => release["tags"]),
      [["1.21.0"], []]
    )
  })

  it("reads a release modversion that is not a string as an empty one, rather than dropping the release", () => {
    // Dropping it would shift releases[0], which newestReleaseFileId turns into the download URL.
    const detail = detailOf({ modid: 1, name: "Versionless", releases: [{ fileid: 42, modversion: null }] })
    assert.equal(detail.releases[0]?.["modversion"], "")
    assert.equal(newestReleaseFileId(detail), 42)
  })

  it("keeps author, text and side only as strings and counts only as finite numbers", () => {
    const odd = detailOf({ modid: 1, name: "Odd", author: null, text: null, side: 7, downloads: "12", follows: "x", releases: [] })
    for (const field of ["author", "text", "side", "downloads", "follows"]) assert.equal(field in odd, false, `${field} survived with the wrong type`)

    const clean = detailOf({ modid: 1, name: "Clean", author: "Ann", text: "<p>x</p>", side: "both", downloads: 12, follows: 3, releases: [] })
    assert.equal(clean.author, "Ann")
    assert.equal(clean.text, "<p>x</p>")
    assert.equal(clean.side, "both")
    assert.equal(clean.downloads, 12)
    assert.equal(clean.follows, 3)
  })

  it("drops a count that JSON.parse read as Infinity", () => {
    const result = parseModDetailResponse('{"statuscode":"200","mod":{"modid":1,"name":"Huge","downloads":1e400,"follows":-1e400,"releases":[]}}')
    if (!result.ok) throw new Error("unreachable")
    assert.equal(result.payload.downloads, undefined)
    assert.equal(result.payload.follows, undefined)
  })

  it("carries every other release field through untouched", () => {
    const detail = detailOf({ modid: 1, name: "Whole", releases: [{ releaseid: 9, fileid: 42, mainfile: "https://mods.example/a.zip", modidstr: "a", changelog: "<p>hi</p>" }] })
    assert.deepEqual(detail.releases[0], {
      releaseid: 9,
      fileid: 42,
      mainfile: "https://mods.example/a.zip",
      modidstr: "a",
      changelog: "<p>hi</p>",
      modversion: "",
      tags: []
    })
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

describe("modDescriptionParagraphs", () => {
  it("splits paragraphs, line breaks and list items into separate paragraphs", () => {
    assert.deepEqual(modDescriptionParagraphs("<p>One</p><p>Two<br>Three</p><ul><li>Four</li></ul><h2>Five</h2><div>Six</div><blockquote>Seven</blockquote>"), [
      "One",
      "Two",
      "Three",
      "Four",
      "Five",
      "Six",
      "Seven"
    ])
  })

  it("drops script and style bodies, not only their tags", () => {
    assert.deepEqual(modDescriptionParagraphs("<p>Hi</p><script>alert(1)</script><style>p{}</style><SCRIPT type='text/javascript'>x()</SCRIPT >"), ["Hi"])
  })

  it("drops a script, style or comment that never closes, through to the end", () => {
    assert.deepEqual(modDescriptionParagraphs("<p>Hi</p><script>alert(1)"), ["Hi"])
    assert.deepEqual(modDescriptionParagraphs("<p>Hi</p><style>p{}"), ["Hi"])
    assert.deepEqual(modDescriptionParagraphs("<p>Hi</p><!-- hidden <p>still hidden</p>"), ["Hi"])
    assert.deepEqual(modDescriptionParagraphs("<p>a</p><!-- note --><p>b</p>"), ["a", "b"])
  })

  it("strips nested and attribute-carrying tags down to their text", () => {
    const html = '<div class="x"><p><b><i>deep</i></b> <a href="https://evil.example" onclick="x()">link</a></p></div><img src="x" onerror="y()"><iframe src="https://evil.example"></iframe>'
    assert.deepEqual(modDescriptionParagraphs(html), ["deep link"])
  })

  it("leaves a tag that never closes as text, which React then shows literally", () => {
    assert.deepEqual(modDescriptionParagraphs("<p>Left <img src=x onerror=alert(1)"), ["Left <img src=x onerror=alert(1)"])
  })

  it("decodes each entity exactly once", () => {
    assert.deepEqual(modDescriptionParagraphs("&amp;lt;b&amp;gt; &lt;i&gt; &#65;&#x42; &quot;q&quot; &apos;s&apos;"), ["&lt;b&gt; <i> AB \"q\" 's'"])
  })

  it("reads entity names and hex digits in any case", () => {
    assert.deepEqual(modDescriptionParagraphs("&AMP; &#X4a;"), ["& J"])
  })

  it("leaves an impossible numeric entity as text instead of throwing", () => {
    assert.deepEqual(modDescriptionParagraphs("&#x110000; &#xD800; &#0; &#1114112;"), ["&#x110000; &#xD800; &#0; &#1114112;"])
  })

  it("collapses whitespace and drops empty paragraphs", () => {
    assert.deepEqual(modDescriptionParagraphs("<p>  a \n b </p><p>&nbsp;</p>"), ["a b"])
  })

  it("answers no paragraphs for a missing or non-string description", () => {
    for (const value of [undefined, null, 42, ["<p>x</p>"]]) assert.deepEqual(modDescriptionParagraphs(value), [])
  })

  it("stays linear on a very long hostile description", () => {
    // The host caps a detail at 4 MB. A pattern that rescans to the end from every `<` would take
    // seconds to minutes on these, and it would freeze the page while it did.
    const size = 400_000
    const started = performance.now()

    assert.deepEqual(modDescriptionParagraphs("<".repeat(size)), ["<".repeat(size)])
    assert.deepEqual(modDescriptionParagraphs("<script ".repeat(size / 8)), ["<script ".repeat(size / 8).trim()])
    assert.deepEqual(modDescriptionParagraphs("<script>".repeat(size / 8)), [])
    assert.deepEqual(modDescriptionParagraphs("<!--".repeat(size / 4)), [])
    assert.deepEqual(modDescriptionParagraphs(`<p>${"word ".repeat(size / 5)}</p>`), ["word ".repeat(size / 5).trim()])

    const elapsed = performance.now() - started
    assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`)
  })
})
