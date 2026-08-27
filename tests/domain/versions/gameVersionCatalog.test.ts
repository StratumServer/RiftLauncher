import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { parseGameVersionCatalog } from "../../../src/domain/versions/gameVersionCatalog"

const GOOD = { filename: "vs_client_win-x64_1.20.4.exe", urls: { cdn: "https://cdn.vintagestory.at/win.exe", local: "" } }

describe("parseGameVersionCatalog", () => {
  it("reads the builds a well-formed catalog carries", () => {
    const catalog = parseGameVersionCatalog(
      JSON.stringify({
        "1.20.4": {
          windows: GOOD,
          linux: { filename: "vs_client_linux-x64_1.20.4.tar.gz", urls: { cdn: "https://cdn.vintagestory.at/linux.tar.gz", local: "" } },
          "mac-x64": { filename: "vs_client_mac-x64_1.20.4.tar.gz", urls: { cdn: "https://cdn.vintagestory.at/mac.tar.gz", local: "" } }
        }
      })
    )

    const version = catalog["1.20.4"]
    assert.equal(version?.windows?.urls.cdn, "https://cdn.vintagestory.at/win.exe")
    assert.equal(version?.windows?.filename, "vs_client_win-x64_1.20.4.exe")
    assert.equal(version?.linux?.urls.cdn, "https://cdn.vintagestory.at/linux.tar.gz")
    assert.equal(version?.["mac-x64"]?.urls.cdn, "https://cdn.vintagestory.at/mac.tar.gz")
  })

  it("answers with an empty catalog for anything that is not an object of versions", () => {
    for (const text of ["", "not json", "{", "null", "7", '"hello"', "[]"]) {
      assert.deepEqual(parseGameVersionCatalog(text), {}, text)
    }
  })

  it("refuses a top-level array even when its rows look like versions", () => {
    assert.deepEqual(parseGameVersionCatalog(JSON.stringify([{ windows: GOOD }])), {})
  })

  it("drops a version that is not an object without losing the good one beside it", () => {
    const catalog = parseGameVersionCatalog(JSON.stringify({ "1.20.4": { windows: GOOD }, "1.20.5": "totally-not-an-object" }))
    assert.deepEqual(Object.keys(catalog), ["1.20.4"])
  })

  it("drops a build whose cdn is not a string without dropping its version", () => {
    const catalog = parseGameVersionCatalog(
      JSON.stringify({
        "1.20.4": { windows: GOOD },
        "1.20.5": { windows: { filename: "vs.exe", urls: { cdn: 12345, local: "" } } }
      })
    )

    assert.deepEqual(Object.keys(catalog).sort(), ["1.20.4", "1.20.5"])
    assert.equal(catalog["1.20.5"]?.windows, undefined)
    assert.equal(JSON.stringify(catalog).includes("12345"), false)
  })

  it("drops a build with no urls object at all", () => {
    const catalog = parseGameVersionCatalog(JSON.stringify({ "1.20.4": { windows: { urls: null } } }))
    assert.deepEqual(Object.keys(catalog), ["1.20.4"])
    assert.equal(catalog["1.20.4"]?.windows, undefined)
  })

  it("drops a build whose filename is not a string", () => {
    const catalog = parseGameVersionCatalog(JSON.stringify({ "1.20.4": { windows: { filename: 7, urls: { cdn: "https://cdn.vintagestory.at/win.exe" } } } }))
    assert.equal(catalog["1.20.4"]?.windows, undefined)
  })

  it("keeps a field the catalog gains later", () => {
    const catalog = parseGameVersionCatalog(
      JSON.stringify({
        "1.20.4": {
          windows: {
            filename: "vs.exe",
            urls: { cdn: "https://cdn.example/vs.exe", local: "", future: true },
            futureBuildField: "preserved"
          },
          futurePlatform: { enabled: true }
        }
      })
    )

    const version = catalog["1.20.4"]
    assert.equal(version?.windows?.urls["future"], true)
    assert.equal(version?.windows?.["futureBuildField"], "preserved")
    assert.deepEqual(version?.["futurePlatform"], { enabled: true })
  })
})
