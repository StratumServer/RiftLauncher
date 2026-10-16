import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { firstFreeFolder, firstHeldFolder, folderIsInside, folderIsInUse, folderOverlapsInUse, normalizeFolderForComparison, parentFolder, toFolderPlatform } from "@domain/paths"

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

  it("preserves a backslash as a literal filename character on posix", () => {
    assert.equal(normalizeFolderForComparison("/home/a/dir\\x", "posix"), "/home/a/dir\\x")
  })

  it("returns an empty string unchanged", () => {
    assert.equal(normalizeFolderForComparison(""), "")
  })

  it("unifies mixed separators on Windows", () => {
    assert.equal(normalizeFolderForComparison("C:/Games\\VS/1.20", "win32"), "c:/games/vs/1.20")
  })

  it("detects UNC folders as Windows paths when the platform is not passed", () => {
    assert.equal(folderIsInUse("\\\\SERVER\\Share\\Versions", ["//server/share/versions"]), true)
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

describe("toFolderPlatform", () => {
  it("keeps the two case-insensitive hosts and folds the rest onto posix", () => {
    assert.equal(toFolderPlatform("win32"), "win32")
    assert.equal(toFolderPlatform("darwin"), "darwin")
    assert.equal(toFolderPlatform("linux"), "posix")
    assert.equal(toFolderPlatform("freebsd"), "posix")
  })
})

describe("folderIsInUse on macOS", () => {
  it("matches names that differ only by case, and keeps a backslash as part of a name", () => {
    assert.equal(folderIsInUse("/Users/p/RL/creative world", ["/Users/p/RL/Creative World"], "darwin"), true)
    assert.equal(folderIsInUse("/Users/p/RL/creative world", ["/Users/p/RL/Creative World"], "posix"), false)
    assert.equal(folderIsInUse("/Users/p/dir\\x", ["/Users/p/dir/x"], "darwin"), false)
  })
})

describe("folderIsInside", () => {
  it("is true for a folder at any depth below the other, and false for the folder itself", () => {
    assert.equal(folderIsInside("/data/Main/Saves", "/data/Main"), true)
    assert.equal(folderIsInside("/data/Main/a/b/c/", "/data/Main/"), true)
    assert.equal(folderIsInside("/data/Main", "/data/Main"), false)
  })

  it("is false for a sibling whose name starts with the other, and for the parent", () => {
    assert.equal(folderIsInside("/data/Main2", "/data/Main"), false)
    assert.equal(folderIsInside("/data", "/data/Main"), false)
  })

  it("takes the root for a folder that holds everything and an empty setting for none", () => {
    assert.equal(folderIsInside("/data/Main", "/"), true)
    assert.equal(folderIsInside("/data/Main", ""), false)
    assert.equal(folderOverlapsInUse("/data/Main", [""]), false)
  })

  it("reads Windows paths whatever their case and separators", () => {
    assert.equal(folderIsInside("C:\\Data\\MAIN\\Saves", "c:/data/main"), true)
    assert.equal(folderIsInside("D:\\Data\\Main", "C:\\Data"), false)
  })

  it("reads case the way the host does", () => {
    assert.equal(folderIsInside("/Users/p/MAIN/Saves", "/Users/p/main", "darwin"), true)
    assert.equal(folderIsInside("/home/p/MAIN/Saves", "/home/p/main", "posix"), false)
  })
})

describe("folderOverlapsInUse", () => {
  it("is true for the same folder, a folder inside one in use and a folder holding one", () => {
    assert.equal(folderOverlapsInUse("/data/Main", ["/data/Main"]), true)
    assert.equal(folderOverlapsInUse("/data/Main/Modded", ["/other", "/data/Main"]), true)
    assert.equal(folderOverlapsInUse("/data", ["/other", "/data/Main"]), true)
  })

  it("is false for unrelated folders and for an empty list", () => {
    assert.equal(folderOverlapsInUse("/data/Main2", ["/data/Main", "/backups"]), false)
    assert.equal(folderOverlapsInUse("/data/Main", []), false)
  })
})

describe("firstHeldFolder", () => {
  it("names the managed folder a folder is, or holds, and none that holds it or sits beside it", () => {
    assert.equal(firstHeldFolder("/data", ["/other", "/data/Installations", "/data/Versions"]), "/data/Installations")
    assert.equal(firstHeldFolder("/data/Installations", ["/data/Installations"]), "/data/Installations")
    assert.equal(firstHeldFolder("/data/Installations/Main", ["/data/Installations"]), null)
    assert.equal(firstHeldFolder("/data/Main2", ["/data/Main"]), null)
  })

  it("holds nothing in an unset folder and compares case the way the platform does", () => {
    assert.equal(firstHeldFolder("/data", ["", "/other"]), null)
    assert.equal(firstHeldFolder("/DATA", ["/data/Installations"], "darwin"), "/data/Installations")
    assert.equal(firstHeldFolder("/DATA", ["/data/Installations"], "posix"), null)
  })
})

describe("firstFreeFolder", () => {
  it("keeps the base when nothing uses it", () => {
    assert.equal(firstFreeFolder("/versions/1.22.7", ["/versions/1.21.6", "/backups"]), "/versions/1.22.7")
  })

  it("moves to -2 when the base is taken, and past the numbers already taken too", () => {
    assert.equal(firstFreeFolder("/versions/1.22.7", ["/versions/1.22.7"]), "/versions/1.22.7-2")
    assert.equal(firstFreeFolder("/versions/1.22.7", ["/versions/1.22.7", "/versions/1.22.7-2"]), "/versions/1.22.7-3")
  })

  it("sees a Windows folder as taken whatever its case and separators", () => {
    assert.equal(firstFreeFolder("C:\\Games\\Versions\\1.22.7", ["c:/games/versions/1.22.7/"]), "C:\\Games\\Versions\\1.22.7-2")
  })

  it("never hands back a taken folder, however many numbered ones are registered", () => {
    // The base and -2 to -99: the old bounded search gave the occupied base back here.
    const taken = ["/v/1.22.7", ...Array.from({ length: 98 }, (_, i) => `/v/1.22.7-${i + 2}`)]
    assert.equal(firstFreeFolder("/v/1.22.7", taken), "/v/1.22.7-100")

    const many = ["/v/1.22.7", ...Array.from({ length: 500 }, (_, i) => `/v/1.22.7-${i + 2}`)]
    const free = firstFreeFolder("/v/1.22.7", many)
    assert.equal(free, "/v/1.22.7-502")
    assert.equal(folderIsInUse(free, many), false)
  })
})

describe("parentFolder", () => {
  it("names the folder a Linux file sits in", () => {
    assert.equal(parentFolder("/home/a/Backups/Installations/Main/Main_2026-08-16_01-20-00.tar.gz"), "/home/a/Backups/Installations/Main")
  })

  it("names the folder of a Windows file, whichever separator the path was written with", () => {
    assert.equal(parentFolder("C:\\Users\\a\\Backups\\Main\\Main.tar.gz"), "C:\\Users\\a\\Backups\\Main")
    assert.equal(parentFolder("C:/Users/a/Backups/Main.tar.gz"), "C:/Users/a/Backups")
    assert.equal(parentFolder("C:\\Users/a\\Backups/Main.zip"), "C:\\Users/a\\Backups")
  })

  it("names the folder of a file on a network share", () => {
    assert.equal(parentFolder("\\\\server\\share\\Backups\\Main\\Main.tar.gz"), "\\\\server\\share\\Backups\\Main")
  })

  it("keeps the case and the separators it was given", () => {
    assert.equal(parentFolder("D:\\Backups\\MAIN\\file.zip"), "D:\\Backups\\MAIN")
  })

  it("reads a backslash as part of a name on Linux", () => {
    assert.equal(parentFolder("/home/a/dir/we\\ird.tar.gz"), "/home/a/dir")
    assert.equal(parentFolder("/home/a/dir\\x/file.tar.gz"), "/home/a/dir\\x")
  })

  it("names no folder for a path with no separator or one directly under a root", () => {
    assert.equal(parentFolder("file.tar.gz"), undefined)
    assert.equal(parentFolder("/file.tar.gz"), undefined)
    assert.equal(parentFolder(""), undefined)
  })
})
