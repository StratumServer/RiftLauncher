import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { MIGRATED_USER_DATA_ENTRIES, planUserDataMigration } from "../../../src/domain/userData/migrationPlan"
import type { UserDataProbe } from "../../../src/domain/userData/migrationPlan"

/**
 * Three booleans in, one plan out, so every input the function can ever get is
 * written down below: the eight rows of the truth table, plus the two rules
 * that hold across all of them.
 */

function probe(riftExists: boolean, vslExists: boolean, staleMigrationExists: boolean): UserDataProbe {
  return { riftExists, vslExists, staleMigrationExists }
}

const ALL_PROBES: readonly UserDataProbe[] = [false, true].flatMap((rift) => [false, true].flatMap((vsl) => [false, true].map((stale) => probe(rift, vsl, stale))))

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
