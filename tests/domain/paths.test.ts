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

  it("strips a trailing backslash and unifies separators", () => {
    assert.equal(normalizeFolderForComparison("C:\\Games\\VS\\"), "c:/games/vs")
  })

  it("lowercases Windows paths (drive letter present) and unifies separators", () => {
    assert.equal(normalizeFolderForComparison("D:\\Users\\Foo\\Games"), "d:/users/foo/games")
  })

  it("lowercases on win32 platform even without drive letter", () => {
    assert.equal(normalizeFolderForComparison("Games\\VintageStory", "win32"), "games/vintagestory")
  })

  it("does not lowercase Linux paths", () => {
    assert.equal(normalizeFolderForComparison("/opt/VintageStory"), "/opt/VintageStory")
  })

  it("does not lowercase a Linux path with a backslash filename character", () => {
    assert.equal(normalizeFolderForComparison("/home/a/dir\\x", "posix"), "/home/a/dir/x")
  })

  it("returns an empty string unchanged", () => {
    assert.equal(normalizeFolderForComparison(""), "")
  })

  it("unifies mixed separators on Windows", () => {
    assert.equal(normalizeFolderForComparison("C:/Games\\VS/1.20", "win32"), "c:/games/vs/1.20")
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

  it("matches mixed separators on Windows", () => {
    assert.equal(folderIsInUse("C:/Games/VS", ["C:\\Games\\VS"], "win32"), true)
  })

  it("does not match different paths", () => {
    assert.equal(folderIsInUse("/opt/game2", ["/opt/game", "/opt/other"]), false)
  })

  it("returns false for an empty list", () => {
    assert.equal(folderIsInUse("/opt/game", []), false)
  })

  it("does not false-positive on a Linux path with backslash as filename char", () => {
    assert.equal(folderIsInUse("/home/a/dir\\x", ["/home/a/DIR\\x"], "posix"), false)
  })
})
