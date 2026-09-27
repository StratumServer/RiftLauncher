import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  answerModDbVisibility,
  defaultModDbVisibility,
  MAX_COUNTED_VERSIONS,
  moddbLaunchAction,
  moddbListingDownloadUrl,
  moddbListingVersion,
  MODDB_LISTING_DETAIL_URL,
  MODDB_VISIBILITY_ALWAYS,
  MODDB_VISIBILITY_ASK,
  MODDB_VISIBILITY_NEVER,
  MODDB_VISIBILITY_ONCE,
  normalizeModDbVisibility,
  rememberCountedVersion,
  type ModDbVisibilityState
} from "@domain/moddbVisibility"

/**
 * The rules behind the ModDB listing count (#219, #477): what a launch owes the listing, what an
 * answer leaves behind, and what a stored answer means when it was written by a launcher that only
 * ever asked once.
 *
 * Every assertion here is about a decision, never about a request: nothing in this module talks to
 * anything. The requests themselves are tests/ipc/moddbListingArchive.test.ts.
 */
const RUNNING = "1.7.0-beta.10"

function state(overrides: Partial<ModDbVisibilityState> = {}): ModDbVisibilityState {
  return { ...defaultModDbVisibility(), ...overrides }
}

describe("moddbLaunchAction", () => {
  it("asks on the first launch of a version nobody has answered for", () => {
    assert.equal(moddbLaunchAction(state(), RUNNING), "prompt")
    assert.equal(moddbLaunchAction(state({ answeredVersion: "1.7.0-beta.9" }), RUNNING), "prompt")
  })

  it("asks nothing twice for the same version once it has been answered", () => {
    assert.equal(moddbLaunchAction(state({ answeredVersion: RUNNING }), RUNNING), "nothing")
  })

  it("counts silently for a player who said always, once per version", () => {
    const always = state({ policy: MODDB_VISIBILITY_ALWAYS, answeredVersion: "1.7.0-beta.9", countedVersions: ["1.7.0-beta.9"] })

    assert.equal(moddbLaunchAction(always, RUNNING), "count")
    assert.equal(moddbLaunchAction(rememberCountedVersion(always, RUNNING), RUNNING), "nothing")
  })

  it("still owes a count for a yes given on this version that never landed, so a later launch retries it", () => {
    // The listing entry is uploaded after the release, so the launch the player answers on is
    // routinely too early for it. The answer is recorded, the count is not, and the next launch of
    // the same version finishes the job without asking again.
    const pending = state({ policy: MODDB_VISIBILITY_ONCE, answeredVersion: RUNNING })

    assert.equal(moddbLaunchAction(pending, RUNNING), "count")
    assert.equal(moddbLaunchAction(rememberCountedVersion(pending, RUNNING), RUNNING), "nothing")
  })

  it("asks again on the next version after a yes that only covered the last one", () => {
    const counted = state({ policy: MODDB_VISIBILITY_ONCE, answeredVersion: "1.7.0-beta.9", countedVersions: ["1.7.0-beta.9"] })
    assert.equal(moddbLaunchAction(counted, RUNNING), "prompt")
  })

  it("does nothing at all, ever, for a player who said never", () => {
    for (const answeredVersion of ["", "1.7.0-beta.9", RUNNING]) {
      assert.equal(moddbLaunchAction(state({ policy: MODDB_VISIBILITY_NEVER, answeredVersion }), RUNNING), "nothing", answeredVersion)
    }
  })

  it("never counts a version twice, whatever the policy says", () => {
    for (const policy of [MODDB_VISIBILITY_ASK, MODDB_VISIBILITY_ONCE, MODDB_VISIBILITY_ALWAYS, MODDB_VISIBILITY_NEVER] as const) {
      assert.equal(moddbLaunchAction(state({ policy, countedVersions: [RUNNING] }), RUNNING), "nothing", policy)
    }
  })

  it("waits while the running version is still being read, rather than asking about a version it does not know", () => {
    assert.equal(moddbLaunchAction(state(), ""), "nothing")
    assert.equal(moddbLaunchAction(state({ policy: MODDB_VISIBILITY_ALWAYS }), ""), "nothing")
  })
})

describe("answerModDbVisibility", () => {
  it("stamps the answer with the version it was given under and keeps what was counted", () => {
    const counted = state({ countedVersions: ["1.7.0-beta.9"] })
    const answered = answerModDbVisibility(counted, MODDB_VISIBILITY_NEVER, RUNNING)

    assert.deepEqual(answered, { policy: MODDB_VISIBILITY_NEVER, answeredVersion: RUNNING, countedVersions: ["1.7.0-beta.9"] })
    // The stored state is replaced rather than edited: the renderer holds it in a reducer.
    assert.notEqual(answered, counted)
    assert.deepEqual(counted.countedVersions, ["1.7.0-beta.9"])
  })
})

describe("rememberCountedVersion", () => {
  it("adds the version once, however many times it is recorded", () => {
    const once = rememberCountedVersion(state(), RUNNING)
    assert.deepEqual(rememberCountedVersion(once, RUNNING).countedVersions, [RUNNING])
  })

  it("keeps the newest versions and drops the oldest past the cap", () => {
    let counted = state()
    for (let index = 0; index < MAX_COUNTED_VERSIONS + 5; index++) counted = rememberCountedVersion(counted, `1.7.0-beta.${index}`)

    assert.equal(counted.countedVersions.length, MAX_COUNTED_VERSIONS)
    assert.equal(counted.countedVersions[0], "1.7.0-beta.5")
    assert.equal(counted.countedVersions.at(-1), `1.7.0-beta.${MAX_COUNTED_VERSIONS + 4}`)
  })

  it("leaves the answer itself alone", () => {
    const answered = state({ policy: MODDB_VISIBILITY_ALWAYS, answeredVersion: "1.7.0-beta.9" })
    const counted = rememberCountedVersion(answered, RUNNING)

    assert.equal(counted.policy, MODDB_VISIBILITY_ALWAYS)
    assert.equal(counted.answeredVersion, "1.7.0-beta.9")
  })
})

describe("moddbListingVersion", () => {
  it("names a beta the way the listing does", () => {
    assert.equal(moddbListingVersion("1.7.0-beta.10"), "1.7.0-pre.10")
    assert.equal(moddbListingVersion("1.7.0-beta.9"), "1.7.0-pre.9")
    assert.equal(moddbListingVersion("2.0.0-beta.1"), "2.0.0-pre.1")
  })

  it("leaves a stable version exactly as it is, since both sides spell it the same", () => {
    assert.equal(moddbListingVersion("1.7.0"), "1.7.0")
    assert.equal(moddbListingVersion("1.20.4"), "1.20.4")
  })

  it("leaves anything else alone rather than guessing at a name", () => {
    // No entry will be found for these, which is a case the count already handles: nothing is
    // counted and nothing is recorded as counted.
    for (const version of ["1.7.0-rc.1", "1.7.0-beta", "1.7.0-beta.x", "1.7.0-beta.10+build.4", ""]) {
      assert.equal(moddbListingVersion(version), version, version)
    }
  })
})

describe("the URLs", () => {
  it("reads the launcher's own listing and counts on the one endpoint that moves the counter", () => {
    assert.equal(MODDB_LISTING_DETAIL_URL, "https://mods.vintagestory.at/api/mod/11016")
    assert.equal(moddbListingDownloadUrl(122116), "https://mods.vintagestory.at/download?fileid=122116")
  })
})

describe("normalizeModDbVisibility", () => {
  it("reads a stored answer back exactly as it was written", () => {
    const stored = { policy: MODDB_VISIBILITY_ALWAYS, answeredVersion: RUNNING, countedVersions: ["1.7.0-beta.9", RUNNING] }
    assert.deepEqual(normalizeModDbVisibility(stored, RUNNING), stored)
  })

  it("falls back to an unanswered question for anything unreadable, rather than inventing a consent", () => {
    for (const value of [undefined, null, 7, true, ["always"], { policy: "ALWAYS" }, { policy: 3 }]) {
      assert.deepEqual(normalizeModDbVisibility(value, RUNNING), defaultModDbVisibility(), JSON.stringify(value))
    }
  })

  it("drops versions that are not usable strings out of a hand-edited config", () => {
    const read = normalizeModDbVisibility({ policy: MODDB_VISIBILITY_ALWAYS, answeredVersion: 7, countedVersions: ["", null, RUNNING, "x".repeat(129)] }, RUNNING)

    assert.equal(read.answeredVersion, "")
    assert.deepEqual(read.countedVersions, [RUNNING])
  })

  /**
   * #219 stored one answer for the lifetime of an install, under a version nobody recorded.
   * Reading it as an answer for the version running now is the only direction that neither asks
   * again about a decision already made nor counts an entry a second time: an acceptance counted
   * whichever entry was newest when it was given, which on the install being read is most likely
   * this one.
   */
  it("reads a #219 acceptance as answered and counted for the running version", () => {
    assert.deepEqual(normalizeModDbVisibility("accepted", RUNNING), { policy: MODDB_VISIBILITY_ASK, answeredVersion: RUNNING, countedVersions: [RUNNING] })
  })

  it("reads a #219 refusal as answered for the running version, with nothing counted", () => {
    for (const answer of ["declined", "already-done"]) {
      assert.deepEqual(normalizeModDbVisibility(answer, RUNNING), { policy: MODDB_VISIBILITY_ASK, answeredVersion: RUNNING, countedVersions: [] }, answer)
    }
  })

  it("reads a #219 answer nobody ever gave as an unanswered question", () => {
    for (const answer of ["unasked", "", "ACCEPTED", "yes"]) {
      assert.deepEqual(normalizeModDbVisibility(answer, RUNNING), defaultModDbVisibility(), answer)
    }
  })

  it("records nothing as counted when a #219 acceptance is read before the running version is known", () => {
    assert.deepEqual(normalizeModDbVisibility("accepted", ""), { policy: MODDB_VISIBILITY_ASK, answeredVersion: "", countedVersions: [] })
  })
})
