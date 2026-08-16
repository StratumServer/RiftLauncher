import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { executeModpackImport, modpackDowngrades, modpackEntriesToResolve, planModpackImport } from "../../../src/domain/mods/importModpack"
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
  return { modid: "carryon", name: "Carry On", version: "1.9.0", path: "/installations/main/Mods/carryon-1.9.0.zip", assetid: 4711, ...overrides }
}

function plan(entries: ModpackEntry[], installed: InstalledModSnapshot[], details: Array<[string, ModpackModDetail]>): ModpackPlanItem[] {
  return planModpackImport({ entries, installed, gameVersion: GAME_VERSION, details: new Map(details) }).items
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

  it("names an unknown mod by its modid, because nothing else is known about it", () => {
    const item = onlyItem(plan([{ modid: "ghostmod", version: "1.0.0" }], [], []))

    assert.deepEqual(item, { decision: "skip", modid: "ghostmod", requestedVersion: "1.0.0", name: "ghostmod", reason: "not-on-moddb", fromVersion: null })
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
