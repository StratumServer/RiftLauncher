import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { checkModHealth, GAME_BUNDLED_MODIDS } from "../../../src/domain/mods/health"
import type { ModHealthCopy, ModHealthFinding } from "../../../src/domain/mods/health"
import { evaluateModCompatibility, findModUpdate } from "../../../src/domain/mods/compatibility"

const GAME_VERSION = "1.20.4"

function aMod(copy: Partial<ModHealthCopy> & { modid: string }): ModHealthCopy {
  return { version: "1.0.0", path: `/Mods/${copy.modid}.zip`, enabled: true, ...copy }
}

/** Everything the check found, in the order it lists it, trimmed to what each assertion is about. */
function kinds(findings: readonly ModHealthFinding[]): string[] {
  return findings.map((finding) => `${finding.section}:${finding.kind}:${finding.modid}`)
}

describe("checkModHealth dependencies", () => {
  it("reports a declared dependency that is nowhere in the folder", () => {
    const findings = checkModHealth({ mods: [aMod({ modid: "alpha", dependencies: { beta: "2.0.0" } })], gameVersion: GAME_VERSION })

    assert.deepEqual(findings, [{ section: "blocking", path: "/Mods/alpha.zip", modid: "alpha", kind: "dependency-missing", dependency: "beta", required: "2.0.0" }])
  })

  it("carries no version bound for a dependency declared with one of the two any-version spellings", () => {
    for (const bound of ["*", ""]) {
      const findings = checkModHealth({ mods: [aMod({ modid: "alpha", dependencies: { beta: bound } })], gameVersion: GAME_VERSION })

      assert.deepEqual(findings, [{ section: "blocking", path: "/Mods/alpha.zip", modid: "alpha", kind: "dependency-missing", dependency: "beta" }])
    }
  })

  it("reports a dependency installed below the declared floor, naming what is there", () => {
    const mods = [aMod({ modid: "alpha", dependencies: { beta: "2.0.0" } }), aMod({ modid: "beta", version: "1.9.0" })]

    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION }), [
      { section: "blocking", path: "/Mods/alpha.zip", modid: "alpha", kind: "dependency-outdated", dependency: "beta", required: "2.0.0", found: "1.9.0" }
    ])
  })

  it("says nothing about a dependency sitting exactly at the declared floor", () => {
    const mods = [aMod({ modid: "alpha", dependencies: { beta: "2.0.0" } }), aMod({ modid: "beta", version: "2.0.0" })]

    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION }), [])
  })

  it("tells a dependency that is turned off apart from one that is not there at all", () => {
    const mods = [aMod({ modid: "alpha", dependencies: { beta: "2.0.0" } }), aMod({ modid: "beta", version: "2.0.0", enabled: false, path: "/Mods/beta.zip.disabled" })]

    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION }), [
      { section: "blocking", path: "/Mods/alpha.zip", modid: "alpha", kind: "dependency-disabled", dependency: "beta", required: "2.0.0" }
    ])
  })

  it("matches a declared mod id against an installed one regardless of case on either side", () => {
    const mods = [aMod({ modid: "Alpha", dependencies: { PrimitiveSurvival: "3.5.1" } }), aMod({ modid: "primitivesurvival", version: "3.5.1" })]

    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION }), [])
  })

  it("skips a comparison neither side can be read for, rather than reporting a folder that is fine", () => {
    const twoPart = [aMod({ modid: "alpha", dependencies: { beta: "1.0" } }), aMod({ modid: "beta", version: "0.9" })]
    assert.deepEqual(checkModHealth({ mods: twoPart, gameVersion: GAME_VERSION }), [])

    const fourPart = [aMod({ modid: "alpha", dependencies: { beta: "2.0.0" } }), aMod({ modid: "beta", version: "1.2.3.4" })]
    assert.deepEqual(checkModHealth({ mods: fourPart, gameVersion: GAME_VERSION }), [])
  })

  it("reads a dependency satisfied by any one of several installed copies as satisfied", () => {
    const mods = [
      aMod({ modid: "alpha", dependencies: { beta: "2.0.0" } }),
      aMod({ modid: "beta", version: "1.0.0", path: "/Mods/beta-old.zip" }),
      aMod({ modid: "beta", version: "2.1.0", path: "/Mods/beta-new.zip" })
    ]

    assert.deepEqual(
      kinds(checkModHealth({ mods, gameVersion: GAME_VERSION })),
      // The two copies of beta still collide; nothing about alpha's dependency is reported.
      ["duplicate:duplicate-modid:beta", "duplicate:duplicate-modid:beta"]
    )
  })

  it("judges a Mod that is turned off neither as a dependent nor as a duplicate", () => {
    const mods = [aMod({ modid: "alpha", enabled: false, path: "/Mods/alpha.zip.disabled", dependencies: { beta: "2.0.0" } }), aMod({ modid: "alpha", version: "1.0.1", path: "/Mods/alpha.zip" })]

    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION }), [])
  })
})

describe("checkModHealth game-bundled mod ids", () => {
  it("reads a bundled id as a floor against the game version, never as a Mod to install", () => {
    for (const bundled of GAME_BUNDLED_MODIDS) {
      const findings = checkModHealth({ mods: [aMod({ modid: "alpha", dependencies: { [bundled]: "1.21.0" } })], gameVersion: "1.20.4" })

      assert.deepEqual(findings, [{ section: "blocking", path: "/Mods/alpha.zip", modid: "alpha", kind: "game-version-below", required: "1.21.0" }])
    }
  })

  it("says nothing when the Installation already runs at or above the declared floor", () => {
    for (const bundled of GAME_BUNDLED_MODIDS) {
      assert.deepEqual(checkModHealth({ mods: [aMod({ modid: "alpha", dependencies: { [bundled]: "1.20.4" } })], gameVersion: "1.20.4" }), [])
      assert.deepEqual(checkModHealth({ mods: [aMod({ modid: "alpha", dependencies: { [bundled]: "1.12.14" } })], gameVersion: "1.20.4" }), [])
    }
  })

  it("reports one sentence for a Mod declaring several bundled ids, at the highest floor it asks for", () => {
    const findings = checkModHealth({ mods: [aMod({ modid: "alpha", dependencies: { game: "1.21.0", survival: "1.22.0", creative: "1.21.0" } })], gameVersion: "1.20.4" })

    assert.deepEqual(findings, [{ section: "blocking", path: "/Mods/alpha.zip", modid: "alpha", kind: "game-version-below", required: "1.22.0" }])
  })

  it("reads the bundled ids however a modinfo.json cased them", () => {
    assert.deepEqual(kinds(checkModHealth({ mods: [aMod({ modid: "alpha", dependencies: { Survival: "1.21.0" } })], gameVersion: "1.20.4" })), ["blocking:game-version-below:alpha"])
  })
})

describe("checkModHealth duplicates", () => {
  it("gives both copies of one mod id a line, each naming the other's archive", () => {
    const mods = [aMod({ modid: "alpha", path: "/Mods/alpha-1.0.0.zip" }), aMod({ modid: "alpha", version: "1.0.1", path: "/Mods/alpha-1.0.1.zip" })]

    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION }), [
      { section: "duplicate", path: "/Mods/alpha-1.0.0.zip", modid: "alpha", kind: "duplicate-modid", other: "/Mods/alpha-1.0.1.zip" },
      { section: "duplicate", path: "/Mods/alpha-1.0.1.zip", modid: "alpha", kind: "duplicate-modid", other: "/Mods/alpha-1.0.0.zip" }
    ])
  })

  it("leaves the enabled and disabled copies of one archive alone, which is a pair and not a collision", () => {
    const mods = [aMod({ modid: "alpha", path: "/Mods/alpha.zip" }), aMod({ modid: "alpha", path: "/Mods/alpha.zip.disabled", enabled: false })]

    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION }), [])
  })
})

describe("checkModHealth ModDB verdicts", () => {
  const releases = [
    { modversion: "2.0.0", tags: ["v1.20.4"] },
    { modversion: "1.5.0", tags: ["1.20.4"] },
    { modversion: "1.0.0", tags: ["1.18.0"] }
  ]

  it("takes the undeclared and update verdicts from compatibility.ts rather than deriving its own", () => {
    const mod = aMod({ modid: "alpha", version: "1.0.0", releases })
    const findings = checkModHealth({ mods: [mod], gameVersion: GAME_VERSION })

    const installedRelease = releases.find((release) => release.modversion === mod.version)
    assert.ok(installedRelease)
    assert.equal(evaluateModCompatibility(installedRelease.tags, GAME_VERSION), "undeclared")
    assert.equal(findModUpdate(mod.version, releases, GAME_VERSION).updatableTo, "1.5.0")

    assert.deepEqual(findings, [
      { section: "undeclared", path: "/Mods/alpha.zip", modid: "alpha", kind: "undeclared" },
      { section: "update", path: "/Mods/alpha.zip", modid: "alpha", kind: "update", toVersion: "1.5.0" }
    ])
  })

  it("says nothing about a release tagged for the game version's own series but not for the version itself", () => {
    // The narrow reading of "not declared" is the whole point of the section: same-minor is what
    // the detail panel words as "should work on the version", so a line here saying nobody has
    // vouched for the Mod would put the two panels at odds about it.
    const tags = ["1.20.1"]
    assert.equal(evaluateModCompatibility(tags, GAME_VERSION), "same-minor")

    const mods = [aMod({ modid: "alpha", version: "1.0.0", releases: [{ modversion: "1.0.0", tags }] })]

    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION }), [])
  })

  it("says nothing about a Mod the ModDB never answered for, and still checks its dependencies", () => {
    const mods = [aMod({ modid: "alpha", version: "0.0.1", dependencies: { beta: "2.0.0" } })]

    assert.deepEqual(kinds(checkModHealth({ mods, gameVersion: GAME_VERSION })), ["blocking:dependency-missing:alpha"])
  })

  it("says nothing about a folder where every Mod is current and declared for the version", () => {
    const mods = [aMod({ modid: "alpha", version: "1.5.0", releases }), aMod({ modid: "beta", version: "1.5.0", releases })]

    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION }), [])
  })
})

describe("checkModHealth held Mods and ordering", () => {
  it("drops every finding whose subject is a held mod id, whichever section it was in", () => {
    const mods = [aMod({ modid: "alpha", version: "1.0.0", dependencies: { beta: "2.0.0" }, releases: [{ modversion: "3.0.0", tags: ["1.20.4"] }] })]

    assert.equal(checkModHealth({ mods, gameVersion: GAME_VERSION }).length, 2)
    assert.deepEqual(checkModHealth({ mods, gameVersion: GAME_VERSION, suspended: ["ALPHA"] }), [])
  })

  it("still reports a held Mod as somebody else's missing dependency", () => {
    const mods = [aMod({ modid: "alpha", dependencies: { beta: "2.0.0" } }), aMod({ modid: "beta", version: "1.0.0" })]

    assert.deepEqual(kinds(checkModHealth({ mods, gameVersion: GAME_VERSION, suspended: ["beta"] })), ["blocking:dependency-outdated:alpha"])
  })

  it("orders findings worst section first, then by mod id, so the caller groups without sorting", () => {
    const mods = [
      aMod({ modid: "zeta", version: "1.0.0", releases: [{ modversion: "2.0.0", tags: ["1.20.4"] }, ...[{ modversion: "1.0.0", tags: ["1.20.4"] }]] }),
      aMod({ modid: "delta", version: "1.0.0", releases: [{ modversion: "1.0.0", tags: ["1.10.0"] }] }),
      aMod({ modid: "beta", path: "/Mods/beta.zip" }),
      aMod({ modid: "beta", path: "/Mods/beta-copy.zip", version: "1.0.1" }),
      aMod({ modid: "alpha", dependencies: { nowhere: "1.0.0" } })
    ]

    assert.deepEqual(kinds(checkModHealth({ mods, gameVersion: GAME_VERSION })), [
      "blocking:dependency-missing:alpha",
      "duplicate:duplicate-modid:beta",
      "duplicate:duplicate-modid:beta",
      "undeclared:undeclared:delta",
      "update:update:zeta"
    ])
  })
})
