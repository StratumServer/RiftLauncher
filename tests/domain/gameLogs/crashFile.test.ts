import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "vitest"

import { MAX_TRACE_FRAMES, parseCrashFile } from "@domain/gameLogs/crashFile"

const FIXTURES = join(__dirname, "..", "..", "fixtures", "gameLogs")

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8")
}

describe("the crash file, across the shapes the game has written", () => {
  it("reads the 1.22 header, its three culprit signals and the head of the trace", () => {
    const crash = parseCrashFile(fixture("crash-1.22.txt"))
    assert.ok(crash)
    assert.deepEqual(crash.at, { y: 2026, mo: 2, d: 22, h: 20, mi: 39, s: 11 })
    assert.equal(crash.blamedModid, "egocaribautomapmarkers")
    assert.equal(crash.blamedVersion, "4.0.3")
    assert.deepEqual(
      crash.loadedMods.map((mod) => mod.modid),
      ["game", "egocaribautomapmarkers", "betterruins", "creative", "survival"]
    )
    assert.deepEqual(crash.harmonyIds, ["Egocarib.AutoMapMarkers.Patches", "BetterRuins.Patches"])
    assert.equal(crash.exceptionType, "System.TypeLoadException")
    assert.match(crash.exceptionMessage as string, /Could not load type 'Vintagestory\.GameContent\.BlockTallGrass'/)
    assert.equal(crash.frames.length, 3)
    assert.match(crash.frames[0] as string, /^at Egocarib\.AutoMapMarkers\.Patches\.Block\.Postfix/)
  })

  it("reads the older locale header, twelve-hour clock and all", () => {
    const crash = parseCrashFile(fixture("crash-older-locale.txt"))
    assert.ok(crash)
    // 12:19:11 PM is noon, not midnight: the one hour the naive "+12" rule gets wrong.
    assert.deepEqual(crash.at, { y: 2022, mo: 10, d: 16, h: 12, mi: 19, s: 11 })
    assert.equal(crash.blamedModid, "carryon")
    assert.deepEqual(crash.harmonyIds, [])
    assert.equal(crash.exceptionType, "System.NullReferenceException")
  })

  it("reports a crash that blames no Mod as exactly that, rather than picking one", () => {
    const crash = parseCrashFile(fixture("crash-no-mod.txt"))
    assert.ok(crash)
    assert.equal(crash.blamedModid, undefined)
    assert.equal(crash.at, undefined)
    assert.equal(crash.exceptionType, "System.AccessViolationException")
    assert.equal(crash.loadedMods.length, 3)
  })

  it("answers nothing at all for a file that is not a crash", () => {
    assert.equal(parseCrashFile(""), null)
    assert.equal(parseCrashFile("Running on 64 bit Linux with 32000 MB RAM\nGame Version: v1.21.1 (Stable)"), null)
  })

  it("bounds the trace it keeps", () => {
    const many = ["System.Exception: boom", ...Array.from({ length: MAX_TRACE_FRAMES + 10 }, (_, index) => `   at Frame${index}()`)].join("\n")
    assert.equal(parseCrashFile(many)?.frames.length, MAX_TRACE_FRAMES)
  })
})
