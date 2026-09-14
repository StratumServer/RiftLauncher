import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "vitest"

import { buildSessionReport, formatReportText, REPORT_TRACE_LINES } from "@domain/gameLogs/report"

const FIXTURES = join(__dirname, "..", "..", "fixtures", "gameLogs")

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8")
}

const INSTALLED = [
  { modid: "ancienttools", name: "Ancient Tools" },
  { modid: "betterruins", name: "Better Ruins" },
  { modid: "egocaribautomapmarkers", name: "Auto Map Markers" }
]

function reportFor(mainLog: string, crashFile?: string): ReturnType<typeof buildSessionReport> {
  return buildSessionReport({
    mainLog: { fileName: "client-main.log", text: fixture(mainLog) },
    ...(crashFile ? { crashFile: { text: fixture(crashFile) } } : {}),
    installedMods: INSTALLED
  })
}

describe("the verdict, which is the whole first line the player reads", () => {
  it("names the Mod the crash file blamed", () => {
    const report = reportFor("no-rungame-main.log", "crash-1.22.txt")
    assert.deepEqual(report.verdict, { kind: "crashed-in-mod", modLabel: "Auto Map Markers" })
  })

  it("says the game crashed, and no more, when the crash file blamed nobody", () => {
    assert.deepEqual(reportFor("normal-session-main.log", "crash-no-mod.txt").verdict, { kind: "crashed" })
  })

  it("says errors were logged when there is no crash file but the log holds errors", () => {
    assert.deepEqual(reportFor("mod-exception-main.log").verdict, { kind: "errors" })
  })

  it("says nothing was logged for a clean session", () => {
    assert.deepEqual(reportFor("normal-session-main.log").verdict, { kind: "clean" })
  })
})

describe("what the report holds", () => {
  const report = reportFor("mod-exception-main.log")

  it("groups the Mods, names them where the launcher recognises the id, and shows the signal", () => {
    const ancient = report.mods.find((mod) => mod.modid === "ancienttools")
    assert.equal(ancient?.name, "Ancient Tools")
    assert.equal(ancient?.signal, "modid-prefix")
    assert.equal(ancient?.errors, 3)
  })

  it("shows a modid the launcher has never seen plainly, because that is a real answer too", () => {
    const { mods } = buildSessionReport({ mainLog: { fileName: "client-main.log", text: "1.1.2026 0:00:00 [Error] [someunknownmod] broke" } })
    assert.equal(mods[0]?.modid, "someunknownmod")
    assert.equal(mods[0]?.name, undefined)
  })

  it("keeps the lines and a short head of their traces", () => {
    const thrown = report.mods.find((mod) => mod.modid === "ancienttools")?.lines.find((line) => line.text.includes("Exception:"))
    assert.equal(thrown?.clock, "13:00:08")
    assert.equal(thrown?.severity, "Error")
    assert.ok((thrown?.continuation.length ?? 0) > 0 && (thrown?.continuation.length ?? 0) <= REPORT_TRACE_LINES)
  })

  it("reports the startup as whole seconds, and claims nothing for a gap it cannot measure", () => {
    const { startup } = reportFor("normal-session-main.log")
    const loadAssets = startup.phases.find((phase) => phase.name === "LoadAssets")
    assert.equal(loadAssets?.seconds, 7)
    // Two markers inside the same second: the log cannot measure that, so no time is claimed.
    const single = buildSessionReport({
      mainLog: { fileName: "client-main.log", text: "1.1.2026 0:00:00 [Event] Entering runphase LoadGame\n1.1.2026 0:00:00 [Event] Entering runphase RunGame" }
    })
    assert.deepEqual(single.startup.phases, [{ name: "LoadGame" }, { name: "RunGame" }])
  })

  it("says when the middle of the log was not read rather than implying it read everything", () => {
    const truncated = buildSessionReport({ mainLog: { fileName: "client-main.log", text: "", truncated: true } })
    assert.equal(truncated.source.truncated, true)
    assert.equal(reportFor("normal-session-main.log").source.truncated, false)
  })
})

describe("the crash section", () => {
  it("lets the crash file outrank the log line when both name the same Mod", () => {
    const report = buildSessionReport({
      mainLog: { fileName: "client-main.log", text: "1.1.2026 0:00:00 [Error] [egocaribautomapmarkers] could not patch" },
      crashFile: { text: fixture("crash-1.22.txt") },
      installedMods: INSTALLED
    })
    assert.equal(report.mods[0]?.signal, "crash-file")
  })

  it("adds a note for a Harmony id naming an installed Mod other than the one blamed", () => {
    // BetterRuins.Patches is on the stack while egocaribautomapmarkers is blamed: a hint, not a cause.
    assert.deepEqual(reportFor("normal-session-main.log", "crash-1.22.txt").crash?.otherPatchLabels, ["Better Ruins"])
  })

  it("never turns a Harmony id into a group of its own", () => {
    const report = reportFor("normal-session-main.log", "crash-1.22.txt")
    assert.deepEqual(report.mods, [])
  })

  it("says nothing about Harmony when the only id involved is the blamed Mod's own", () => {
    const report = buildSessionReport({
      crashFile: { text: fixture("crash-1.22.txt").replace(", BetterRuins.Patches", "") },
      installedMods: INSTALLED
    })
    assert.deepEqual(report.crash?.otherPatchLabels, [])
  })
})

describe("what leaves the process", () => {
  it("redacts every string it holds, paths, tokens and the player's own account", () => {
    const text = [
      "1.1.2026 0:00:00 [Error] [ancienttools] failed reading C:\\Users\\Will\\AppData\\Roaming\\Vintagestory\\config.json",
      "   at Thing.Read() in /home/will/src/mod/Thing.cs:line 9",
      "1.1.2026 0:00:01 [Error] sessionkey=abc123 for Will_T (will@example.com)"
    ].join("\n")

    const report = buildSessionReport({
      mainLog: { fileName: "client-main.log", text },
      installedMods: INSTALLED,
      accountValues: ["will@example.com", "Will_T"]
    })
    const copied = formatReportText(report)

    assert.ok(!copied.includes("C:\\Users"), "a Windows path reached the copied report")
    assert.ok(!copied.includes("/home/will"), "a Linux home path reached the copied report")
    assert.ok(!copied.includes("abc123"), "a token value reached the copied report")
    assert.ok(!copied.includes("will@example.com"), "the player's email reached the copied report")
    assert.ok(!copied.includes("Will_T"), "the player's name reached the copied report")
    assert.match(copied, /\[PATH\]/)
    assert.match(copied, /\[ACCOUNT\]/)
  })

  it("lays the report out top to bottom, verdict first", () => {
    const copied = formatReportText(reportFor("mod-exception-main.log"))
    assert.match(copied, /^The game exited with errors\.\nFrom client-main\.log\./)
    assert.match(copied, /By Mod\n {2}Ancient Tools \(3 errors, 0 warnings, named by the log line\)/)
    assert.match(copied, /Startup\n {2}Initialization/)
    assert.match(copied, /Anything else/)
  })

  it("carries the crash and its note into the copied text", () => {
    const copied = formatReportText(reportFor("normal-session-main.log", "crash-1.22.txt"))
    assert.match(copied, /^The game crashed in Auto Map Markers\./)
    assert.match(copied, /Blamed Mod: Auto Map Markers 4\.0\.3/)
    assert.match(copied, /A patch from Better Ruins was involved\./)
  })
})
