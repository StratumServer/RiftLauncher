import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "vitest"

import { attributeEntries, MAX_ENTRIES_PER_GROUP, MAX_MOD_GROUPS, modidForAssembly } from "@domain/gameLogs/attribution"
import { MAX_CONTINUATION_LINES, MAX_LINE_CHARS, parseLogLines, toSeconds } from "@domain/gameLogs/lines"
import { readPhaseTimeline } from "@domain/gameLogs/phases"

const FIXTURES = join(__dirname, "..", "..", "fixtures", "gameLogs")

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8")
}

describe("the client log line grammar", () => {
  it("reads a timestamped line into its parts", () => {
    const entries = parseLogLines("26.4.2025 13:00:08 [Error] [ancienttools] Exception: boom")
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0]?.at, { y: 2025, mo: 4, d: 26, h: 13, mi: 0, s: 8 })
    assert.equal(entries[0]?.severity, "Error")
    assert.equal(entries[0]?.message, "[ancienttools] Exception: boom")
  })

  it("keeps a stack trace as the continuation of the entry it followed", () => {
    const entries = parseLogLines(fixture("mod-exception-main.log"))
    const thrown = entries.find((entry) => entry.message.startsWith("[ancienttools] Exception:"))
    assert.ok(thrown, "the fixture no longer carries the ancienttools exception this test reads")
    assert.equal(thrown.continuation.length, 2)
    assert.match(thrown.continuation[0] as string, /at AncientTools\.Utility\.ModConfig\.ReadConfig/)
  })

  it("drops the mangled leading run a tail read produces", () => {
    const entries = parseLogLines(fixture("mod-exception-main.log"))
    // The fixture opens mid-frame, the way a file cut at 1.5 MiB from the end does. That half line
    // belongs to no entry, so it is dropped rather than attached to the first real one.
    assert.equal(entries[0]?.message, "Entering runphase Initialization")
    assert.equal(entries[0]?.continuation.length, 0)
  })

  it("leaves the timestamp absent rather than wrong when the line names no real date", () => {
    const entries = parseLogLines(fixture("no-rungame-main.log"))
    const mangled = entries[entries.length - 1]
    assert.equal(mangled?.at, undefined)
    assert.equal(mangled?.severity, "Error")
    assert.equal(mangled?.message, "Something wrote a date the calendar does not have.")
  })

  it("bounds a line and the run of continuations one entry can drag along", () => {
    const long = `1.1.2026 0:00:00 [Error] ${"x".repeat(MAX_LINE_CHARS + 200)}`
    assert.equal(parseLogLines(long)[0]?.message.length, MAX_LINE_CHARS)

    const trace = [`1.1.2026 0:00:00 [Error] boom`, ...Array.from({ length: MAX_CONTINUATION_LINES + 10 }, (_, index) => `   at Frame${index}()`)].join("\n")
    assert.equal(parseLogLines(trace)[0]?.continuation.length, MAX_CONTINUATION_LINES)
  })

  it("puts two timestamps on one axis so a midnight rollover still subtracts", () => {
    const [before, after] = parseLogLines("1.1.2026 23:59:59 [Event] a\n2.1.2026 0:00:01 [Event] b")
    assert.equal(toSeconds(after?.at as never) - toSeconds(before?.at as never), 2)
  })
})

describe("the startup timeline", () => {
  it("reads the entry markers and the landmarks the startup counted", () => {
    const { phases, landmarks } = readPhaseTimeline(parseLogLines(fixture("normal-session-main.log")))

    assert.deepEqual(
      phases.map((phase) => phase.name),
      ["Initialization", "Configuration", "LoadAssets", "AssetsFinalize", "LoadGamePre", "LoadGame", "WorldReady", "RunGame"]
    )
    // LoadAssets to AssetsFinalize, the phase the fixture spends its time in.
    assert.equal((phases[3]?.atSecond as number) - (phases[2]?.atSecond as number), 7)
    assert.deepEqual(landmarks, [
      { kind: "mods", count: 24 },
      { kind: "modSystems", count: 177 },
      { kind: "blocks", count: 33308 }
    ])
  })

  it("reports what it saw when the session never reached RunGame", () => {
    const { phases, landmarks } = readPhaseTimeline(parseLogLines(fixture("no-rungame-main.log")))
    assert.deepEqual(
      phases.map((phase) => phase.name),
      ["Initialization", "Configuration", "LoadAssets", "AssetsFinalize", "LoadGamePre"]
    )
    assert.deepEqual(landmarks, [])
  })
})

describe("attributing an error to a Mod", () => {
  const installed = ["ancienttools", "betterruins", "egocaribautomapmarkers"]
  const attributed = attributeEntries(parseLogLines(fixture("mod-exception-main.log")), installed)

  it("names a Mod off the bracket the log line carries", () => {
    const group = attributed.groups.find((candidate) => candidate.modid === "ancienttools")
    assert.equal(group?.signal, "modid-prefix")
    assert.equal(group?.errors, 3)
    assert.equal(group?.warnings, 0)
  })

  it("names a Mod off the assembly when the line carries no bracket", () => {
    // "Failed to run mod phase Pre for mod AncientTools.Utility.RegisterConfig": the leading segment
    // is the only thing tying it to an installed Mod, and it landed in the group above.
    assert.equal(attributed.groups.filter((group) => group.modid === "ancienttools").length, 1)
    assert.equal(modidForAssembly("AncientTools.Utility.RegisterConfig", installed), "ancienttools")
    assert.equal(modidForAssembly("Someone.Unknown.Thing", installed), undefined)
    assert.equal(modidForAssembly("", installed), undefined)
  })

  it("counts warnings apart from errors", () => {
    const group = attributed.groups.find((candidate) => candidate.modid === "betterruins")
    assert.equal(group?.errors, 0)
    assert.equal(group?.warnings, 1)
  })

  it("keeps an honest bucket for what no rule could name", () => {
    assert.deepEqual(
      attributed.unattributed.map((entry) => entry.message),
      ["Failed to run mod phase Pre for mod Someone.Unknown.Thing", "Texture atlas is full, some blocks will render untextured."]
    )
  })

  it("ignores everything that is not an error or a warning", () => {
    const { groups, unattributed } = attributeEntries(parseLogLines("1.1.2026 0:00:00 [Notification] [ancienttools] loaded fine"), ["ancienttools"])
    assert.deepEqual(groups, [])
    assert.deepEqual(unattributed, [])
  })

  it("bounds the groups and the lines each keeps, loudest group first", () => {
    const noisy = Array.from({ length: MAX_MOD_GROUPS + 5 }, (_, index) => `1.1.2026 0:00:0${index % 10} [Warning] [mod${index}] noisy`).join("\n")
    const loud = Array.from({ length: MAX_ENTRIES_PER_GROUP + 5 }, () => `1.1.2026 0:00:00 [Error] [loudmod] broke`).join("\n")
    const { groups } = attributeEntries(parseLogLines(`${loud}\n${noisy}`), [])

    assert.equal(groups.length, MAX_MOD_GROUPS)
    assert.equal(groups[0]?.modid, "loudmod")
    assert.equal(groups[0]?.errors, MAX_ENTRIES_PER_GROUP + 5)
    assert.equal(groups[0]?.entries.length, MAX_ENTRIES_PER_GROUP)
  })
})
