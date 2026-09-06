import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  clampModpackModName,
  executeModpackImport,
  MAX_MODPACK_MOD_NAME_LENGTH,
  modpackDowngrades,
  modpackEntriesToResolve,
  modpackRowLabel,
  modpackRowStatus,
  planModpackImport
} from "../../../src/domain/mods/importModpack"
import type { InstalledModSnapshot, ModpackEntry, ModpackImportEntryReport, ModpackInstallItem, ModpackModDetail, ModpackPlanItem, ModpackRelease } from "../../../src/domain/mods/importModpack"
import type { InstallModResult } from "../../../src/domain/mods/install"

const GAME_VERSION = "1.20.4"

function release(modversion: string, tags: string[]): ModpackRelease {
  return { mainfile: `https://mods.vintagestory.at/download?v=${modversion}`, modidstr: "carryon", modversion, tags }
}

function detail(releases: ModpackRelease[], overrides: Partial<ModpackModDetail> = {}): ModpackModDetail {
  return { name: "Carry On", assetid: 4711, releases, ...overrides }
}

function installedCopy(overrides: Partial<InstalledModSnapshot> = {}): InstalledModSnapshot {
  return { modid: "carryon", name: "Carry On", version: "1.9.0", path: "/installations/main/Mods/carryon-1.9.0.zip", enabled: true, assetid: 4711, ...overrides }
}

function plan(entries: ModpackEntry[], installed: InstalledModSnapshot[], details: Array<[string, ModpackModDetail]>, failedModids?: readonly string[]): ModpackPlanItem[] {
  return planModpackImport({ entries, installed, gameVersion: GAME_VERSION, details: new Map(details), failedModids: failedModids && new Set(failedModids) }).items
}

function onlyItem(items: ModpackPlanItem[]): ModpackPlanItem {
  assert.equal(items.length, 1)
  return items[0] as ModpackPlanItem
}

function installItem(items: ModpackPlanItem[]): ModpackInstallItem {
  const item = onlyItem(items)
  assert.equal(item.decision, "install")
  return item as ModpackInstallItem
}

describe("modpackEntriesToResolve", () => {
  it("skips the lookup for a mod already sitting at the requested version", () => {
    const entries = [{ modid: "carryon", version: "1.9.0" }]

    assert.deepEqual(modpackEntriesToResolve(entries, [installedCopy()]), [])
  })

  it("still asks about a mod whose only copy is disabled, at the requested version or not (#287)", () => {
    const entries = [{ modid: "carryon", version: "1.9.0" }]

    assert.deepEqual(modpackEntriesToResolve(entries, [installedCopy({ enabled: false })]), entries)
  })

  it("asks about a mod installed at another version", () => {
    const entries = [{ modid: "carryon", version: "2.0.1" }]

    assert.deepEqual(modpackEntriesToResolve(entries, [installedCopy()]), entries)
  })

  it("asks about a mod that is not installed at all", () => {
    const entries = [{ modid: "primitivesurvival", version: "3.7.0" }]

    assert.deepEqual(modpackEntriesToResolve(entries, [installedCopy()]), entries)
  })
})

describe("modpackDowngrades", () => {
  it("names the entries that would replace an installed copy with an older one", () => {
    const entries = [
      { modid: "carryon", version: "1.5.0" },
      { modid: "primitivesurvival", version: "3.7.0" }
    ]

    assert.deepEqual(modpackDowngrades(entries, [installedCopy()]), [{ modid: "carryon", version: "1.5.0" }])
  })

  it("counts neither an equal version nor a mod that is not installed", () => {
    const entries = [
      { modid: "carryon", version: "1.9.0" },
      { modid: "primitivesurvival", version: "3.7.0" }
    ]

    assert.deepEqual(modpackDowngrades(entries, [installedCopy()]), [])
  })
})

describe("planModpackImport release pick order", () => {
  const exact = release("1.5.0", ["1.19.1"])
  const compatible = release("2.0.1", ["1.20.3"])
  const latest = release("3.0.0", ["1.21.0"])

  it("takes the exact version the manifest asks for, even over a newer compatible release", () => {
    const item = installItem(plan([{ modid: "carryon", version: "1.5.0" }], [], [["carryon", detail([latest, compatible, exact])]]))

    assert.equal(item.release.modversion, "1.5.0")
  })

  it("falls back to the best compatible release when the exact version is gone", () => {
    const item = installItem(plan([{ modid: "carryon", version: "9.9.9" }], [], [["carryon", detail([latest, compatible, exact])]]))

    assert.equal(item.release.modversion, "2.0.1")
    assert.equal(item.compatibility, "same-minor")
  })

  it("prefers a release tagged for the exact game version over one merely in the same series", () => {
    const declared = release("2.0.0", ["1.20.4"])
    const item = installItem(plan([{ modid: "carryon", version: "9.9.9" }], [], [["carryon", detail([declared, compatible])]]))

    assert.equal(item.release.modversion, "2.0.0")
    assert.equal(item.compatibility, "declared")
  })

  it("falls back to the newest release of all when nothing is tagged for this game series", () => {
    const item = installItem(plan([{ modid: "carryon", version: "9.9.9" }], [], [["carryon", detail([latest, exact])]]))

    assert.equal(item.release.modversion, "3.0.0")
    assert.equal(item.compatibility, "undeclared", "the fallback is offered, never dressed up as compatible")
  })

  it("keeps the whole order in one plan: exact, then compatible, then latest", () => {
    const details: Array<[string, ModpackModDetail]> = [
      ["exactly", detail([latest, compatible, exact], { name: "Exactly" })],
      ["compatibly", detail([latest, compatible], { name: "Compatibly" })],
      ["lastly", detail([latest], { name: "Lastly" })]
    ]

    const items = planModpackImport({
      entries: [
        { modid: "exactly", version: "1.5.0" },
        { modid: "compatibly", version: "1.5.0" },
        { modid: "lastly", version: "1.5.0" }
      ],
      installed: [],
      gameVersion: GAME_VERSION,
      details: new Map(details)
    }).items

    assert.deepEqual(
      items.map((item) => (item.decision === "install" ? item.release.modversion : item.reason)),
      ["1.5.0", "2.0.1", "3.0.0"]
    )
  })
})

describe("planModpackImport decisions", () => {
  it("leaves a mod alone when the folder already holds the requested version", () => {
    const item = onlyItem(plan([{ modid: "carryon", version: "1.9.0" }], [installedCopy()], []))

    assert.deepEqual(item, {
      decision: "skip",
      modid: "carryon",
      requestedVersion: "1.9.0",
      name: "Carry On",
      assetid: 4711,
      reason: "already-present",
      fromVersion: "1.9.0"
    })
  })

  it("reinstalls over a disabled copy of the requested version rather than calling it present (#287)", () => {
    const disabled = installedCopy({ enabled: false, path: "/installations/main/Mods/carryon-1.9.0.zip.disabled" })
    const item = installItem(plan([{ modid: "carryon", version: "1.9.0" }], [disabled], [["carryon", detail([release("1.9.0", ["1.20.4"])])]]))

    // A pack is a playable set. Reporting the disabled copy as already there would leave the player
    // with a pack whose game cannot load one of its mods, so the copy is replaced by an enabled one.
    assert.equal(item.release.modversion, "1.9.0")
    assert.deepEqual(item.existing, { path: "/installations/main/Mods/carryon-1.9.0.zip.disabled", version: "1.9.0" })
  })

  it("names an unknown mod by its modid, because nothing else is known about it", () => {
    const item = onlyItem(plan([{ modid: "ghostmod", version: "1.0.0" }], [], []))

    assert.deepEqual(item, { decision: "skip", modid: "ghostmod", requestedVersion: "1.0.0", name: "ghostmod", reason: "not-on-moddb", fromVersion: null })
  })

  // #384: a modid absent from `details` is not always a clean 404. When the caller has told the
  // plan that this particular lookup never answered, the row must say the database was
  // unreachable, not that the mod is a fork or a private build.
  it("tells a lookup that failed apart from one that genuinely found nothing, for the same absent detail", () => {
    const failed = onlyItem(plan([{ modid: "ghostmod", version: "1.0.0" }], [], [], ["ghostmod"]))
    assert.deepEqual(failed, { decision: "skip", modid: "ghostmod", requestedVersion: "1.0.0", name: "ghostmod", reason: "lookup-failed", fromVersion: null })

    const notFound = onlyItem(plan([{ modid: "ghostmod", version: "1.0.0" }], [], []))
    assert.equal(notFound.decision === "skip" && notFound.reason, "not-on-moddb")
  })

  it("reports a page that publishes no release at all", () => {
    const item = onlyItem(plan([{ modid: "carryon", version: "2.0.1" }], [], [["carryon", detail([])]]))

    assert.deepEqual(item, { decision: "skip", modid: "carryon", requestedVersion: "2.0.1", name: "Carry On", assetid: 4711, reason: "no-release", fromVersion: null })
  })

  it("carries the copy it will replace, so the installer can remove exactly that file", () => {
    const item = installItem(plan([{ modid: "carryon", version: "2.0.1" }], [installedCopy()], [["carryon", detail([release("2.0.1", ["1.20.4"])])]]))

    assert.deepEqual(item.existing, { path: "/installations/main/Mods/carryon-1.9.0.zip", version: "1.9.0" })
    assert.equal(item.fromVersion, "1.9.0")
    assert.equal(item.downgrade, false)
  })

  it("flags an install that walks a mod backwards", () => {
    const item = installItem(plan([{ modid: "carryon", version: "1.5.0" }], [installedCopy()], [["carryon", detail([release("1.5.0", ["1.20.4"])])]]))

    assert.equal(item.downgrade, true)
  })

  it("collects the downgrades of a plan", () => {
    const result = planModpackImport({
      entries: [
        { modid: "carryon", version: "1.5.0" },
        { modid: "primitivesurvival", version: "3.7.0" }
      ],
      installed: [installedCopy()],
      gameVersion: GAME_VERSION,
      details: new Map<string, ModpackModDetail>([
        ["carryon", detail([release("1.5.0", ["1.20.4"])])],
        ["primitivesurvival", detail([release("3.7.0", ["1.20.4"])], { name: "Primitive Survival" })]
      ])
    })

    assert.deepEqual(
      result.downgrades.map((item) => item.modid),
      ["carryon"]
    )
  })

  it("keeps manifest order whatever each entry settles on", () => {
    const items = plan(
      [
        { modid: "ghostmod", version: "1.0.0" },
        { modid: "carryon", version: "2.0.1" }
      ],
      [],
      [["carryon", detail([release("2.0.1", ["1.20.4"])])]]
    )

    assert.deepEqual(
      items.map((item) => item.modid),
      ["ghostmod", "carryon"]
    )
  })
})

/** An installer that answers per modid, so a test can fail exactly one entry. */
function fakeInstaller(outcomes: Record<string, InstallModResult> = {}): { installer: { install: (item: ModpackInstallItem) => Promise<InstallModResult> }; installed: string[] } {
  const installed: string[] = []

  return {
    installed,
    installer: {
      install: async (item: ModpackInstallItem): Promise<InstallModResult> => {
        installed.push(item.modid)
        return outcomes[item.modid] ?? { ok: true, fileName: `${item.release.modidstr}-${item.release.modversion}.zip`, path: `/installations/main/Mods/${item.release.modversion}.zip` }
      }
    }
  }
}

function importPlan(): ReturnType<typeof planModpackImport> {
  return planModpackImport({
    entries: [
      { modid: "carryon", version: "2.0.1" },
      { modid: "ghostmod", version: "1.0.0" },
      { modid: "primitivesurvival", version: "3.7.0" }
    ],
    installed: [installedCopy()],
    gameVersion: GAME_VERSION,
    details: new Map<string, ModpackModDetail>([
      ["carryon", detail([release("2.0.1", ["1.20.4"])])],
      ["primitivesurvival", detail([release("3.7.0", ["1.20.4"])], { name: "Primitive Survival", assetid: 15 })]
    ])
  })
}

describe("executeModpackImport", () => {
  it("installs the planned entries and reports every one of them in manifest order", async () => {
    const { installer, installed } = fakeInstaller()

    const report = await executeModpackImport({ installer }, { plan: importPlan() })

    assert.deepEqual(installed, ["carryon", "primitivesurvival"], "an unknown mod is never handed to the installer")
    assert.deepEqual(
      report.entries.map((entry) => [entry.modid, entry.status, entry.fromVersion, entry.toVersion]),
      [
        ["carryon", "installed", "1.9.0", "2.0.1"],
        ["ghostmod", "not-on-moddb", null, null],
        ["primitivesurvival", "installed", null, "3.7.0"]
      ]
    )
    assert.equal(report.installed, 2)
    assert.equal(report.failed, 0)
  })

  it("carries on past a failing mod and names the reason it stopped on that one", async () => {
    const { installer } = fakeInstaller({ carryon: { ok: false, reason: "old-version-delete-failed" } })

    const report = await executeModpackImport({ installer }, { plan: importPlan() })

    assert.deepEqual(
      report.entries.map((entry) => [entry.modid, entry.status, entry.toVersion]),
      [
        ["carryon", "old-version-delete-failed", null],
        ["ghostmod", "not-on-moddb", null],
        ["primitivesurvival", "installed", "3.7.0"]
      ]
    )
    assert.equal(report.installed, 1)
    assert.equal(report.failed, 1, "a planned skip is not a failure, only a planned install that did not happen")
  })

  it("reports an already-present mod as sitting where it was, never as a failure", async () => {
    const { installer, installed } = fakeInstaller()

    const report = await executeModpackImport(
      { installer },
      { plan: planModpackImport({ entries: [{ modid: "carryon", version: "1.9.0" }], installed: [installedCopy()], gameVersion: GAME_VERSION, details: new Map() }) }
    )

    assert.deepEqual(installed, [])
    assert.deepEqual(report.entries, [{ modid: "carryon", name: "Carry On", assetid: 4711, fromVersion: "1.9.0", toVersion: "1.9.0", status: "already-present" }])
    assert.equal(report.failed, 0)
  })

  it("announces each install before it runs and every entry once it settles", async () => {
    const { installer } = fakeInstaller({ carryon: { ok: false, reason: "download-failed" } })
    const trace: string[] = []
    const settled: ModpackImportEntryReport[] = []

    await executeModpackImport(
      { installer },
      { plan: importPlan() },
      {
        onEntryStarted: (modid) => trace.push(`started:${modid}`),
        onEntrySettled: (report) => {
          trace.push(`settled:${report.modid}:${report.status}`)
          settled.push(report)
        }
      }
    )

    assert.deepEqual(trace, ["started:carryon", "settled:carryon:download-failed", "settled:ghostmod:not-on-moddb", "started:primitivesurvival", "settled:primitivesurvival:installed"])
    assert.equal(settled.length, 3)
  })

  it("has nothing to do with an empty manifest", async () => {
    const { installer } = fakeInstaller()

    const report = await executeModpackImport({ installer }, { plan: planModpackImport({ entries: [], installed: [], gameVersion: GAME_VERSION, details: new Map() }) })

    assert.deepEqual(report, { entries: [], installed: 0, failed: 0 })
  })
})

describe("modpackRowLabel", () => {
  it("prefers the name the ModDB answered with", () => {
    assert.equal(modpackRowLabel({ modid: "tradie", version: "1.4.0", name: "Traders Expansion (local build)" }, "Traders Expansion"), "Traders Expansion")
  })

  it("falls back to the name the pack was exported with when nothing resolved (#379)", () => {
    assert.equal(modpackRowLabel({ modid: "alloycalculatorstuzzichino", version: "1.0.4", name: "Alloy Calculator" }, undefined), "Alloy Calculator")
  })

  // A skipped plan item names itself after its own modid when no ModDB page answered, so a resolved
  // name equal to the modid is not a name at all.
  it("reads a resolved name equal to the modid as no name and takes the local one", () => {
    assert.equal(modpackRowLabel({ modid: "animationslib", version: "1.2.0", name: "Animations Library" }, "animationslib"), "Animations Library")
  })

  it("falls back to the modid for a pack exported before names were written", () => {
    assert.equal(modpackRowLabel({ modid: "waterwheelriverflowfix", version: "1.0.0" }, undefined), "waterwheelriverflowfix")
  })

  it("treats a blank local name as no name", () => {
    assert.equal(modpackRowLabel({ modid: "sandwich", version: "2.1.0", name: "   " }, undefined), "sandwich")
  })

  it("takes the ModDB name over a modid even when the pack carries no local name", () => {
    assert.equal(modpackRowLabel({ modid: "hqzlights", version: "1.1.0" }, "Braziers"), "Braziers")
  })
})

describe("modpackRowStatus", () => {
  function statusOf(
    entries: ModpackEntry[],
    installed: InstalledModSnapshot[],
    details: Array<[string, ModpackModDetail]>,
    failedModids?: readonly string[]
  ): ReturnType<typeof modpackRowStatus> {
    return modpackRowStatus(onlyItem(plan(entries, installed, details, failedModids)))
  }

  it("calls a mod the installation does not have a new install", () => {
    const status = statusOf([{ modid: "carryon", version: "2.0.1" }], [], [["carryon", detail([release("2.0.1", ["v1.20.4"])])]])

    assert.deepEqual(status, { kind: "new", fromVersion: null, toVersion: "2.0.1" })
  })

  it("calls a newer release over an older copy an update, and carries both versions", () => {
    const status = statusOf([{ modid: "carryon", version: "2.0.1" }], [installedCopy()], [["carryon", detail([release("2.0.1", ["v1.20.4"])])]])

    assert.deepEqual(status, { kind: "update", fromVersion: "1.9.0", toVersion: "2.0.1" })
  })

  it("calls an older release over a newer copy a downgrade, and carries both versions", () => {
    const status = statusOf([{ modid: "carryon", version: "1.5.0" }], [installedCopy()], [["carryon", detail([release("1.5.0", ["v1.20.4"])])]])

    assert.deepEqual(status, { kind: "downgrade", fromVersion: "1.9.0", toVersion: "1.5.0" })
  })

  // #287: a pack is a playable set, so a copy the player turned off is reinstalled enabled. The row
  // has to say the copy on disk is going away rather than call it a fresh install.
  it("warns that a disabled copy at the very same version is still replaced", () => {
    const status = statusOf([{ modid: "carryon", version: "1.9.0" }], [installedCopy({ enabled: false })], [["carryon", detail([release("1.9.0", ["v1.20.4"])])]])

    assert.deepEqual(status, { kind: "replace", fromVersion: "1.9.0", toVersion: "1.9.0" })
  })

  // The hand-edited copy from the #379 report: its version string was changed locally, so nothing on
  // the ModDB matches it and the release that is picked lands on the same version it already has.
  it("warns that a copy whose version the manifest does not match is replaced", () => {
    const status = statusOf([{ modid: "carryon", version: "1.9.0-mine" }], [installedCopy()], [["carryon", detail([release("1.9.0", ["v1.20.4"])])]])

    assert.deepEqual(status, { kind: "replace", fromVersion: "1.9.0", toVersion: "1.9.0" })
  })

  it("says a mod already sitting at the requested version stays where it is", () => {
    const status = statusOf([{ modid: "carryon", version: "1.9.0" }], [installedCopy()], [])

    assert.deepEqual(status, { kind: "already-present", fromVersion: "1.9.0", toVersion: "1.9.0" })
  })

  it("says nothing will be installed for a modid no listing declares", () => {
    const status = statusOf([{ modid: "alloycalculatorstuzzichino", version: "1.0.4" }], [], [])

    assert.deepEqual(status, { kind: "not-on-moddb", fromVersion: null, toVersion: null })
  })

  it("says the lookup could not be checked, for a modid whose query failed rather than answered 404", () => {
    const status = statusOf([{ modid: "alloycalculatorstuzzichino", version: "1.0.4" }], [], [], ["alloycalculatorstuzzichino"])

    assert.deepEqual(status, { kind: "lookup-failed", fromVersion: null, toVersion: null })
  })

  it("says nothing will be installed for a page that publishes no release, and still names the copy on disk", () => {
    const status = statusOf([{ modid: "carryon", version: "2.0.1" }], [installedCopy()], [["carryon", detail([])]])

    assert.deepEqual(status, { kind: "no-release", fromVersion: "1.9.0", toVersion: null })
  })
})

describe("clampModpackModName", () => {
  it("leaves a name at or under the cap untouched", () => {
    assert.equal(clampModpackModName("Traders Expansion"), "Traders Expansion")
    const atCap = "a".repeat(MAX_MODPACK_MOD_NAME_LENGTH)
    assert.equal(clampModpackModName(atCap), atCap)
  })

  it("cuts a name over the cap down to exactly the cap the manifest reader accepts", () => {
    const long = "a".repeat(MAX_MODPACK_MOD_NAME_LENGTH + 50)
    const clamped = clampModpackModName(long)

    assert.equal(clamped.length, MAX_MODPACK_MOD_NAME_LENGTH)
    assert.equal(clamped, "a".repeat(MAX_MODPACK_MOD_NAME_LENGTH))
  })

  // A cut that lands mid-surrogate-pair leaves a lone high surrogate at the end of the string,
  // which is not a character at all. The whole astral character is dropped instead, one code unit
  // short of the cap, rather than shipping half of it.
  it("never splits a surrogate pair sitting right on the cut", () => {
    const straddling = "a".repeat(MAX_MODPACK_MOD_NAME_LENGTH - 1) + "🎮" + "bbbb"
    const clamped = clampModpackModName(straddling)

    assert.equal(clamped, "a".repeat(MAX_MODPACK_MOD_NAME_LENGTH - 1))
    assert.equal(clamped.length, MAX_MODPACK_MOD_NAME_LENGTH - 1)
  })
})
