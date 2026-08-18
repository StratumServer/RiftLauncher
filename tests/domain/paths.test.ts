import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { folderIsInUse, normalizeFolderForComparison } from "@domain/paths"

describe("normalizeFolderForComparison", () => {
  it("strips a trailing forward slash", () => {
    assert.equal(normalizeFolderForComparison("/opt/game/"), "/opt/game")
  })

  it("strips multiple trailing slashes", () => {
    assert.equal(normalizeFolderForComparison("/opt/game///"), "/opt/game")
  })

  it("strips a trailing backslash", () => {
    assert.equal(normalizeFolderForComparison("C:\\Games\\VS\\"), "c:\\games\\vs")
  })

  it("lowercases Windows paths (drive letter present)", () => {
    assert.equal(normalizeFolderForComparison("D:\\Users\\Foo\\Games"), "d:\\users\\foo\\games")
  })

  it("lowercases when backslashes are present without a drive letter", () => {
    assert.equal(normalizeFolderForComparison("Games\\VintageStory"), "games\\vintagestory")
  })

  it("does not lowercase Linux paths", () => {
    assert.equal(normalizeFolderForComparison("/opt/VintageStory"), "/opt/VintageStory")
  })

  it("returns an empty string unchanged", () => {
    assert.equal(normalizeFolderForComparison(""), "")
  })
})

describe("folderIsInUse", () => {
  it("matches an exact path", () => {
    assert.equal(folderIsInUse("/opt/game", ["/opt/game", "/opt/other"]), true)
  })

  it("matches with trailing slash difference", () => {
    assert.equal(folderIsInUse("/opt/game/", ["/opt/game"]), true)
  })

  it("matches case-insensitively on Windows paths", () => {
    assert.equal(folderIsInUse("C:\\Games\\VS", ["c:\\games\\vs"]), true)
  })

  it("does not match different paths", () => {
    assert.equal(folderIsInUse("/opt/game2", ["/opt/game", "/opt/other"]), false)
  })

  it("returns false for an empty list", () => {
    assert.equal(folderIsInUse("/opt/game", []), false)
  })
})
