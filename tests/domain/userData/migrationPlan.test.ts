import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { holdsPlayerChoice, IMPORT_PENDING_MARKER_FILE, MIGRATED_USER_DATA_ENTRIES, planUserDataMigration } from "../../../src/domain/userData/migrationPlan"
import type { UserDataProbe } from "../../../src/domain/userData/migrationPlan"

/**
 * Three booleans in, one plan out, so every input the function can ever get is
 * written down below: the eight rows of the truth table, plus the two rules
 * that hold across all of them.
 */

function probe(riftExists: boolean, vslExists: boolean, staleMigrationExists: boolean, riftImportPending = false): UserDataProbe {
  return { riftExists, riftImportPending, vslExists, staleMigrationExists }
}

const ALL_PROBES: readonly UserDataProbe[] = [false, true].flatMap((rift) =>
  [false, true].flatMap((vsl) => [false, true].flatMap((stale) => [false, true].map((pending) => probe(rift, vsl, stale, pending && rift))))
)

describe("planUserDataMigration", () => {
  it("uses a RiftLauncher folder that is already there", () => {
    assert.deepEqual(planUserDataMigration(probe(true, false, false)), { action: "use-existing", cleanStaleMigration: false })
  })

  it("still uses it when a VS Launcher folder is there too, and leaves that one alone", () => {
    assert.deepEqual(planUserDataMigration(probe(true, true, false)), { action: "use-existing", cleanStaleMigration: false })
  })

  it("migrates when only the VS Launcher folder exists", () => {
    assert.deepEqual(planUserDataMigration(probe(false, true, false)), { action: "migrate", cleanStaleMigration: false, copy: MIGRATED_USER_DATA_ENTRIES })
  })

  it("starts fresh when neither folder exists", () => {
    assert.deepEqual(planUserDataMigration(probe(false, false, false)), { action: "fresh", cleanStaleMigration: false })
  })

  it("asks for the leftover temporary folder to go, whatever it then does", () => {
    assert.deepEqual(planUserDataMigration(probe(true, false, true)), { action: "use-existing", cleanStaleMigration: true })
    assert.deepEqual(planUserDataMigration(probe(true, true, true)), { action: "use-existing", cleanStaleMigration: true })
    assert.deepEqual(planUserDataMigration(probe(false, true, true)), { action: "migrate", cleanStaleMigration: true, copy: MIGRATED_USER_DATA_ENTRIES })
    assert.deepEqual(planUserDataMigration(probe(false, false, true)), { action: "fresh", cleanStaleMigration: true })
  })

  it("tries the import again when the RiftLauncher folder holds the failed-import marker and VS Launcher's folder is still there (#708)", () => {
    assert.deepEqual(planUserDataMigration(probe(true, true, false, true)), { action: "migrate", cleanStaleMigration: false, copy: MIGRATED_USER_DATA_ENTRIES })
    assert.deepEqual(planUserDataMigration(probe(true, true, true, true)), { action: "migrate", cleanStaleMigration: true, copy: MIGRATED_USER_DATA_ENTRIES })
  })

  it("keeps using a marked folder when there is nothing left to import from", () => {
    assert.deepEqual(planUserDataMigration(probe(true, false, false, true)), { action: "use-existing", cleanStaleMigration: false })
  })

  it("names the marker file", () => {
    assert.equal(IMPORT_PENDING_MARKER_FILE, "vs-launcher-import-pending")
  })

  it("copies config.json and the icons, and nothing that can be rebuilt", () => {
    assert.deepEqual([...MIGRATED_USER_DATA_ENTRIES], ["config.json", "Icons"])

    const plan = planUserDataMigration(probe(false, true, false))
    assert.equal(plan.action, "migrate")
    if (plan.action !== "migrate") return

    const copied: readonly string[] = plan.copy
    assert.equal(copied.includes("Logs"), false)
    assert.equal(copied.includes("Cache"), false)
    assert.equal(copied.includes("account-secrets.json"), false)
  })

  it("mirrors the leftover flag on every input, and never invents a fourth action", () => {
    for (const input of ALL_PROBES) {
      const plan = planUserDataMigration(input)
      assert.equal(plan.cleanStaleMigration, input.staleMigrationExists)
      assert.equal(["use-existing", "migrate", "fresh"].includes(plan.action), true)
    }
  })
})

describe("holdsPlayerChoice (#708)", () => {
  const untouched = {
    schemaVersion: 3,
    favMods: [],
    window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
    lastSeenChangelogVersion: "",
    moddbVisibility: { policy: "ask", answeredVersion: "", countedVersions: [] }
  }

  it("sees nothing chosen in the document a first start writes, or in an empty one", () => {
    assert.equal(holdsPlayerChoice(untouched, untouched), false)
    assert.equal(holdsPlayerChoice({}, untouched), false)
  })

  it("does not count what a first start fills in by itself: the window, the changelog version and the schema version", () => {
    assert.equal(holdsPlayerChoice({ ...untouched, window: { width: 900, height: 600, x: 10, y: 20, maximized: true } }, untouched), false)
    assert.equal(holdsPlayerChoice({ ...untouched, lastSeenChangelogVersion: "1.7.0" }, untouched), false)
    assert.equal(holdsPlayerChoice({ ...untouched, schemaVersion: 2 }, untouched), false)
  })

  it("counts any other field that differs, an unknown field included", () => {
    assert.equal(holdsPlayerChoice({ ...untouched, favMods: [5] }, untouched), true)
    assert.equal(holdsPlayerChoice({ ...untouched, somethingNew: 1 }, untouched), true)
  })

  it.each([
    ["never", { policy: "never", answeredVersion: "1.7.0", countedVersions: [] }],
    ["always", { policy: "always", answeredVersion: "1.7.0", countedVersions: [] }],
    ["a yes for this version only", { policy: "once", answeredVersion: "1.7.0", countedVersions: [] }],
    ["not this time", { policy: "ask", answeredVersion: "1.7.0", countedVersions: [] }],
    ["a policy changed on the settings page", { policy: "never", answeredVersion: "", countedVersions: [] }],
    ["a count", { policy: "ask", answeredVersion: "", countedVersions: ["1.7.0"] }]
  ])("counts the ModDB answer %s: nothing writes that field before the player does", (_name, moddbVisibility) => {
    assert.equal(holdsPlayerChoice({ ...untouched, moddbVisibility }, untouched), true)
  })
})
