import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  beginModProfileSwitch,
  captureModProfile,
  createModProfile,
  deleteModProfile,
  duplicateModProfile,
  emptyModProfilesDocument,
  finishModProfileSwitch,
  MAX_MOD_PROFILES,
  normalizeModProfilesDocument,
  planModProfileSwitch,
  renameModProfile,
  validateModProfileName
} from "../../../src/domain/mods/profiles"
import type { ProfileScannedMod } from "../../../src/domain/mods/profiles"
import { MAX_MOD_ARCHIVES } from "../../../src/domain/mods/scanInstalled"

function aProfile(id: string, name: string, mods: ModProfileEntry[] = []): ModProfile {
  return { id, name, mods }
}

function aDocument(profiles: ModProfile[], activeProfileId: string | null = null): ModProfilesDocument {
  return { format: 1, activeProfileId, profiles }
}

function on(modid: string, path: string): ProfileScannedMod {
  return { modid, path, enabled: true }
}

function off(modid: string, path: string): ProfileScannedMod {
  return { modid, path, enabled: false }
}

/** The document a normalization must have produced, failing the test with the problem otherwise. */
function normalized(value: unknown): ModProfilesDocument {
  const result = normalizeModProfilesDocument(value)
  assert.ok(result.ok, `expected a document, got ${JSON.stringify(result)}`)
  return result.document
}

describe("normalizeModProfilesDocument", () => {
  it("reads a missing file as no profiles and no active one", () => {
    assert.deepEqual(normalizeModProfilesDocument(undefined), { ok: true, document: { format: 1, activeProfileId: null, profiles: [] } })
  })

  it("refuses a document from a newer format rather than cleaning it", () => {
    assert.deepEqual(normalizeModProfilesDocument({ format: 2, activeProfileId: null, profiles: [] }), { ok: false, problem: "newer-format" })
  })

  it("calls anything that is not a format-1 document unreadable, so it is never overwritten", () => {
    for (const value of [null, "profiles", 1, [], {}, { format: "1", profiles: [] }, { format: 0, profiles: [] }, { format: 1.5, profiles: [] }]) {
      assert.deepEqual(normalizeModProfilesDocument(value), { ok: false, problem: "unreadable" }, JSON.stringify(value))
    }
  })

  it("drops a malformed profile and keeps the rest, first of two duplicate ids and first of two names that differ only by case", () => {
    const document = normalized({
      format: 1,
      activeProfileId: null,
      profiles: [
        { id: "a", name: "Server", mods: [] },
        { id: "b", name: "Solo", mods: "not a list" },
        { id: "a", name: "Other", mods: [] },
        { id: "c", name: "server", mods: [] },
        { id: "d", name: "Creative", mods: [] }
      ]
    })

    assert.deepEqual(document.profiles, [aProfile("a", "Server"), aProfile("d", "Creative")])
  })

  it("drops a profile whose id, name or shape breaks the rules, and trims a name that is otherwise fine", () => {
    const document = normalized({
      format: 1,
      activeProfileId: null,
      profiles: [
        "not a profile",
        { id: "../escape", name: "Bad id", mods: [] },
        { id: "", name: "Empty id", mods: [] },
        { id: "x".repeat(65), name: "Long id", mods: [] },
        { id: 7, name: "Number id", mods: [] },
        { id: "e", name: "Line\nbreak", mods: [] },
        { id: "f", name: "   ", mods: [] },
        { id: "g", name: "n".repeat(65), mods: [] },
        { id: "h", name: 42, mods: [] },
        { id: "i", name: "  Kept  ", mods: [] }
      ]
    })

    assert.deepEqual(document.profiles, [aProfile("i", "Kept")])
  })

  it("drops every entry that is not a modid and an enabled archive name, and keeps the rest", () => {
    const document = normalized({
      format: 1,
      activeProfileId: null,
      profiles: [
        {
          id: "a",
          name: "Server",
          mods: [
            { modid: "alpha", file: "alpha-1.0.0.zip" },
            { modid: "upper", file: "UPPER-1.0.0.ZIP" },
            { modid: "", file: "empty.zip" },
            { modid: "m".repeat(257), file: "long.zip" },
            { modid: "nul\0", file: "nul.zip" },
            { modid: "traversal", file: "../../evil.zip" },
            { modid: "folder", file: "sub/evil.zip" },
            { modid: "windows", file: "sub\\evil.zip" },
            { modid: "dots", file: ".." },
            { modid: "disabled", file: "x.zip.disabled" },
            { modid: "text", file: "notes.txt" },
            { modid: "nulfile", file: "a\0.zip" },
            { modid: "longfile", file: `${"f".repeat(252)}.zip` },
            { modid: "missing" },
            "not an entry"
          ]
        }
      ]
    })

    assert.deepEqual(document.profiles[0]?.mods, [
      { modid: "alpha", file: "alpha-1.0.0.zip" },
      { modid: "upper", file: "UPPER-1.0.0.ZIP" }
    ])
  })

  it("keeps at most one scan's worth of entries per profile", () => {
    const mods = Array.from({ length: MAX_MOD_ARCHIVES + 1 }, (_, index) => ({ modid: `mod${index}`, file: `mod${index}.zip` }))
    const document = normalized({ format: 1, activeProfileId: null, profiles: [{ id: "a", name: "Big", mods }] })

    assert.equal(document.profiles[0]?.mods.length, MAX_MOD_ARCHIVES)
    assert.deepEqual(document.profiles[0]?.mods.at(-1), { modid: `mod${MAX_MOD_ARCHIVES - 1}`, file: `mod${MAX_MOD_ARCHIVES - 1}.zip` })
  })

  it("nulls an active id that names no profile, and keeps one that does", () => {
    const profiles = [{ id: "a", name: "Server", mods: [] }]
    assert.equal(normalized({ format: 1, activeProfileId: "ghost", profiles }).activeProfileId, null)
    assert.equal(normalized({ format: 1, activeProfileId: 3, profiles }).activeProfileId, null)
    assert.equal(normalized({ format: 1, activeProfileId: "a", profiles }).activeProfileId, "a")
    // Named, but only by a profile that was itself dropped.
    assert.equal(normalized({ format: 1, activeProfileId: "b", profiles: [...profiles, { id: "b", name: "server", mods: [] }] }).activeProfileId, null)
  })

  it("reads a document with no profile list as one with no profiles", () => {
    assert.deepEqual(normalized({ format: 1, activeProfileId: null }), emptyModProfilesDocument())
  })

  it("keeps at most 50 profiles, the first 50", () => {
    const profiles = Array.from({ length: MAX_MOD_PROFILES + 1 }, (_, index) => ({ id: `p${index}`, name: `Profile ${index}`, mods: [] }))
    const document = normalized({ format: 1, activeProfileId: null, profiles })

    assert.equal(MAX_MOD_PROFILES, 50)
    assert.deepEqual(
      document.profiles.map((profile) => profile.id),
      profiles.slice(0, 50).map((profile) => profile.id)
    )
  })
})

describe("captureModProfile", () => {
  it("records only the enabled archives, by modid and file name", () => {
    assert.deepEqual(captureModProfile([on("alpha", "/x/Mods/alpha-1.0.0.zip"), off("beta", "C:\\x\\Mods\\beta-2.0.0.zip.disabled"), on("gamma", "C:\\x\\Mods\\gamma-3.0.0.zip")]), [
      { modid: "alpha", file: "alpha-1.0.0.zip" },
      { modid: "gamma", file: "gamma-3.0.0.zip" }
    ])
  })
})

describe("planModProfileSwitch", () => {
  it("matches a Mod updated to a new file name on its modid alone", () => {
    const plan = planModProfileSwitch(aProfile("a", "Server", [{ modid: "alpha", file: "alpha-1.0.0.zip" }]), [off("alpha", "/x/Mods/alpha-1.1.0.zip.disabled")])

    assert.deepEqual(plan, { changes: [{ path: "/x/Mods/alpha-1.1.0.zip.disabled", enabled: true }], missing: 0, unresolved: 0 })
  })

  it("compares modids without regard to case", () => {
    const plan = planModProfileSwitch(aProfile("a", "Server", [{ modid: "Alpha", file: "alpha-1.0.0.zip" }]), [off("alpha", "/x/Mods/alpha-1.0.0.zip.disabled"), on("BETA", "/x/Mods/beta.zip")])

    assert.deepEqual(plan.changes, [
      { path: "/x/Mods/alpha-1.0.0.zip.disabled", enabled: true },
      { path: "/x/Mods/beta.zip", enabled: false }
    ])
    assert.equal(plan.missing, 0)
  })

  it("turns off what the profile does not list and leaves alone what is already right", () => {
    const plan = planModProfileSwitch(aProfile("a", "Server", [{ modid: "alpha", file: "alpha.zip" }]), [
      on("alpha", "/x/Mods/alpha.zip"),
      on("beta", "/x/Mods/beta.zip"),
      off("gamma", "/x/Mods/gamma.zip.disabled")
    ])

    assert.deepEqual(plan, { changes: [{ path: "/x/Mods/beta.zip", enabled: false }], missing: 0, unresolved: 0 })
  })

  it("with two archives of one modid, turns on only the one the profile recorded", () => {
    const plan = planModProfileSwitch(aProfile("a", "Server", [{ modid: "alpha", file: "alpha-1.1.0.zip" }]), [on("alpha", "/x/Mods/alpha-1.0.0.zip"), on("alpha", "/x/Mods/alpha-1.1.0.zip")])

    assert.deepEqual(plan, { changes: [{ path: "/x/Mods/alpha-1.0.0.zip", enabled: false }], missing: 0, unresolved: 0 })
  })

  it("with two archives of one modid, finds the recorded one by its enabled name while it is off", () => {
    const plan = planModProfileSwitch(aProfile("a", "Server", [{ modid: "alpha", file: "alpha-1.1.0.zip" }]), [
      on("alpha", "C:\\x\\Mods\\alpha-1.0.0.zip"),
      off("alpha", "C:\\x\\Mods\\alpha-1.1.0.zip.disabled")
    ])

    assert.deepEqual(plan.changes, [
      { path: "C:\\x\\Mods\\alpha-1.0.0.zip", enabled: false },
      { path: "C:\\x\\Mods\\alpha-1.1.0.zip.disabled", enabled: true }
    ])
  })

  it("with two archives of one modid and neither recorded, leaves both and counts one unresolved", () => {
    const plan = planModProfileSwitch(aProfile("a", "Server", [{ modid: "alpha", file: "alpha-0.9.0.zip" }]), [
      on("alpha", "/x/Mods/alpha-1.0.0.zip"),
      off("alpha", "/x/Mods/alpha-1.1.0.zip.disabled")
    ])

    assert.deepEqual(plan, { changes: [], missing: 0, unresolved: 1 })
  })

  it("counts the listed Mods that are no longer installed, once per modid", () => {
    const plan = planModProfileSwitch(
      aProfile("a", "Server", [
        { modid: "alpha", file: "alpha.zip" },
        { modid: "delta", file: "delta-1.0.0.zip" },
        { modid: "Delta", file: "delta-2.0.0.zip" }
      ]),
      [on("alpha", "/x/Mods/alpha.zip")]
    )

    assert.deepEqual(plan, { changes: [], missing: 1, unresolved: 0 })
  })

  it("plans nothing the second time, once the folder matches", () => {
    const profile = aProfile("a", "Server", [{ modid: "alpha", file: "alpha.zip" }])
    assert.deepEqual(planModProfileSwitch(profile, [on("alpha", "/x/Mods/alpha.zip"), off("beta", "/x/Mods/beta.zip.disabled")]).changes, [])
  })
})

describe("profile document transforms", () => {
  const folder = [on("alpha", "/x/Mods/alpha.zip"), off("beta", "/x/Mods/beta.zip.disabled"), on("gamma", "/x/Mods/gamma.zip")]
  const live = [
    { modid: "alpha", file: "alpha.zip" },
    { modid: "gamma", file: "gamma.zip" }
  ]
  const stale = [{ modid: "beta", file: "beta.zip" }]

  it("beginning a switch records the active profile live and clears the active id; finishing sets the target", () => {
    const document = aDocument([aProfile("a", "Server", stale), aProfile("b", "Solo", stale)], "a")

    const begun = beginModProfileSwitch(document, folder)
    assert.deepEqual(begun, aDocument([aProfile("a", "Server", live), aProfile("b", "Solo", stale)], null))
    assert.deepEqual(finishModProfileSwitch(begun, "b"), aDocument([aProfile("a", "Server", live), aProfile("b", "Solo", stale)], "b"))
  })

  it("beginning a switch with no active profile records nothing", () => {
    const document = aDocument([aProfile("a", "Server", stale)], null)
    assert.deepEqual(beginModProfileSwitch(document, folder), document)
  })

  it("creating while another profile is active records that one first and activates the new one", () => {
    const created = createModProfile(aDocument([aProfile("a", "Server", stale), aProfile("b", "Solo", stale)], "a"), "c", "Creative", folder)

    assert.deepEqual(created, aDocument([aProfile("a", "Server", live), aProfile("b", "Solo", stale), aProfile("c", "Creative", live)], "c"))
  })

  it("renaming changes the name only", () => {
    const document = aDocument([aProfile("a", "Server", stale), aProfile("b", "Solo", stale)], "b")
    assert.deepEqual(renameModProfile(document, "a", "Public server"), aDocument([aProfile("a", "Public server", stale), aProfile("b", "Solo", stale)], "b"))
  })

  it("deleting the active profile clears the active id and leaves every other profile", () => {
    const document = aDocument([aProfile("a", "Server", stale), aProfile("b", "Solo", live)], "a")

    assert.deepEqual(deleteModProfile(document, "a"), aDocument([aProfile("b", "Solo", live)], null))
    // An inactive one leaves the active id where it was.
    assert.deepEqual(deleteModProfile(document, "b"), aDocument([aProfile("a", "Server", stale)], "a"))
  })

  it("duplicating twice names the copies apart, and a copy of the active profile takes the live folder", () => {
    const document = aDocument([aProfile("a", "Server", stale)], "a")

    const once = duplicateModProfile(document, "a", "b", folder)
    const twice = duplicateModProfile(once, "a", "c", folder)

    assert.deepEqual(twice, aDocument([aProfile("a", "Server", stale), aProfile("b", "Server copy", live), aProfile("c", "Server copy 2", live)], "a"))
  })

  it("duplicating an inactive profile copies its stored set and activates nothing", () => {
    const document = aDocument([aProfile("a", "Server", stale), aProfile("b", "Solo", live)], "b")

    const copied = duplicateModProfile(document, "a", "c", folder)
    assert.deepEqual(copied, aDocument([aProfile("a", "Server", stale), aProfile("b", "Solo", live), aProfile("c", "Server copy", stale)], "b"))
    assert.notEqual(copied.profiles[2]?.mods[0], stale[0], "the copy shares no entry object with its source")
  })

  it("duplicating a profile whose name is already at the limit cuts it so the copy still fits", () => {
    const longName = "n".repeat(64)
    const copied = duplicateModProfile(aDocument([aProfile("a", longName)]), "a", "b", folder)

    assert.equal(copied.profiles[1]?.name, `${"n".repeat(59)} copy`)
    assert.equal(normalized(copied).profiles.length, 2)
  })

  it("duplicating a profile that is not there changes nothing", () => {
    const document = aDocument([aProfile("a", "Server")])
    assert.equal(duplicateModProfile(document, "ghost", "b", folder), document)
  })
})

describe("validateModProfileName", () => {
  const profiles = [aProfile("a", "Server"), aProfile("b", "Solo")]

  it("trims an accepted name", () => {
    assert.deepEqual(validateModProfileName("  Creative ", profiles), { ok: true, name: "Creative" })
    assert.deepEqual(validateModProfileName("n".repeat(64), profiles), { ok: true, name: "n".repeat(64) })
  })

  it("refuses an empty, over-long, control-character or case-duplicate name, and allows renaming a profile to its own name in another case", () => {
    assert.deepEqual(validateModProfileName("   ", profiles), { ok: false, problem: "empty" })
    assert.deepEqual(validateModProfileName("n".repeat(65), profiles), { ok: false, problem: "too-long" })
    assert.deepEqual(validateModProfileName("Tab\there", profiles), { ok: false, problem: "control-character" })
    assert.deepEqual(validateModProfileName("Bell\u0085", profiles), { ok: false, problem: "control-character" })
    assert.deepEqual(validateModProfileName("server", profiles), { ok: false, problem: "taken" })
    assert.deepEqual(validateModProfileName("server", profiles, "b"), { ok: false, problem: "taken" })
    assert.deepEqual(validateModProfileName("SERVER", profiles, "a"), { ok: true, name: "SERVER" })
  })
})
