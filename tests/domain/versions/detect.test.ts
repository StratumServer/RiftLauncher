import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { detectInstalledGameVersion } from "../../../src/domain/versions/detect"
import type { DetectInstalledGameVersionInput, DetectInstalledGameVersionPorts } from "../../../src/domain/versions/detect"
import type { PathBuilder, ProcessProbe, ProcessProbeOutcome, ProcessProbeRequest } from "../../../src/domain/ports"

const FOLDER = "/games/1.20.4"

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

const fakePaths: PathBuilder = { join: async (parts: string[]): Promise<string> => parts.join("/") }

function fakeProbe(outcome: ProcessProbeOutcome = { ok: true, stdout: "1.20.4\n" }): { processProbe: ProcessProbe; requests: ProcessProbeRequest[] } {
  const requests: ProcessProbeRequest[] = []
  const processProbe: ProcessProbe = {
    run: async (request: ProcessProbeRequest): Promise<ProcessProbeOutcome> => {
      trace.push(`probe:${request.command} ${request.args.join(" ")}`)
      requests.push(request)
      return outcome
    }
  }
  return { processProbe, requests }
}

function fakePorts(overrides: Partial<DetectInstalledGameVersionPorts> = {}): DetectInstalledGameVersionPorts {
  return {
    paths: fakePaths,
    processProbe: fakeProbe().processProbe,
    ...overrides
  }
}

function input(overrides: Partial<DetectInstalledGameVersionInput> = {}): DetectInstalledGameVersionInput {
  return {
    platform: "linux",
    folder: FOLDER,
    fileNames: ["Vintagestory"],
    ...overrides
  }
}

beforeEach(() => {
  trace = []
})

describe("detectInstalledGameVersion executable selection", () => {
  it("runs the native Linux launcher directly when it is present", async () => {
    const { processProbe, requests } = fakeProbe({ ok: true, stdout: "1.20.4" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input({ fileNames: ["Vintagestory", "readme.txt"] }))

    assert.deepEqual(result, { ok: true, version: "1.20.4" })
    assert.deepEqual(requests, [{ command: `${FOLDER}/Vintagestory`, args: ["-v"] }])
  })

  it("prefers the native Linux launcher over the mono fallback when both are present", async () => {
    const { processProbe, requests } = fakeProbe()

    await detectInstalledGameVersion(fakePorts({ processProbe }), input({ fileNames: ["Vintagestory", "Vintagestory.exe"] }))

    assert.equal(requests[0]?.command, `${FOLDER}/Vintagestory`)
  })

  it("falls back to the mono executable on Linux when the native launcher is absent", async () => {
    const { processProbe, requests } = fakeProbe()

    await detectInstalledGameVersion(fakePorts({ processProbe }), input({ fileNames: ["Vintagestory.exe"] }))

    assert.deepEqual(requests, [{ command: "mono", args: [`${FOLDER}/Vintagestory.exe`, "-v"] }])
  })

  it("runs the Windows executable directly, never through mono", async () => {
    const { processProbe, requests } = fakeProbe()

    await detectInstalledGameVersion(fakePorts({ processProbe }), input({ platform: "win32", fileNames: ["Vintagestory.exe"] }))

    assert.deepEqual(requests, [{ command: `${FOLDER}/Vintagestory.exe`, args: ["-v"] }])
  })

  it("refuses a folder with none of the expected executables, without probing anything", async () => {
    const { processProbe, requests } = fakeProbe()

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input({ fileNames: ["readme.txt"] }))

    assert.deepEqual(result, { ok: false, reason: "no-executable" })
    assert.deepEqual(requests, [])
  })

  it("refuses every macOS folder, since there is no expectation to check there yet", async () => {
    const { processProbe, requests } = fakeProbe()

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input({ platform: "darwin", fileNames: ["Vintagestory"] }))

    assert.deepEqual(result, { ok: false, reason: "no-executable" })
    assert.deepEqual(requests, [])
  })

  it("treats an unknown platform as Linux, like the rest of the domain does", async () => {
    const { processProbe, requests } = fakeProbe()

    await detectInstalledGameVersion(fakePorts({ processProbe }), input({ platform: "freebsd", fileNames: ["Vintagestory"] }))

    assert.deepEqual(requests, [{ command: `${FOLDER}/Vintagestory`, args: ["-v"] }])
  })
})

describe("detectInstalledGameVersion probe interpretation", () => {
  it("trims the version the probe printed", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "  1.20.4  \n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.20.4" })
  })

  it("reports a probe the host could not run to completion", async () => {
    const { processProbe } = fakeProbe({ ok: false, stdout: "", error: "spawn ENOENT" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: false, reason: "probe-failed" })
  })

  it("reports a probe that printed nothing usable, rather than an empty version", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "   " })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: false, reason: "unreadable-version" })
  })

  it("picks the game's version out of an Optimum boot, not the versions Optimum logs about itself", async () => {
    const { processProbe } = fakeProbe({
      ok: true,
      stdout: [
        "[Optimum] Shader compatibility scan: sources=48, shaders=12, conflicts=0, failed=False, fingerprint=4f0ab21c73d9e5a180c2b6f47e31a9d8c05be7f21a4d63c8907e5fb2a1d64c3e",
        "[Optimum] Optimum v0.3.14",
        "[Optimum] Shader owner: chunkopaque.fsh <- betterruins_1.9.2-4f0ab21c73 (last writer)",
        "1.21.1",
        ""
      ].join("\n")
    })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(
      result,
      { ok: true, version: "1.21.1", variant: { name: "Optimum", version: "0.3.14" } },
      "0.3.14 is Optimum's own version and 1.9.2-4f0ab21c73 is a mod archive stem; only the game prints a version on a line of its own"
    )
  })

  it("keeps a pre-release version whole", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "[Optimum] boot\n1.21.0-rc.1\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.21.0-rc.1" })
  })

  it("takes the version printed on its own line over one mentioned inside a sentence", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "1.21.1\nbuilt against 1.20.4\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.21.1" })
  })

  it("skips a token semver rejects when scanning a line that holds more than a version", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "Build 01.02.03 of 1.21.1\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.21.1" }, "semver refuses leading zeros, so the scan carries on to the next token instead of stopping at the first regex match")
  })

  it("refuses a four-part build number instead of reading the first three parts as a version", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "1.21.1.2\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: false, reason: "unreadable-version" }, "1.21.1 is the first three parts of a build number nobody published, not the version this binary answered with")
  })

  it("refuses an IP address instead of reading its first three octets as a version", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "127.0.0.1\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: false, reason: "unreadable-version" })
  })

  it("scans past a dotted token that is not a version and takes the real one later on the same line", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "server 127.0.0.1 running 1.21.1\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.21.1" })
  })

  it("finds the version on its own line when an earlier line held an address", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "listening on 127.0.0.1\n1.21.1\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.21.1" })
  })

  it("keeps a pre-release whole when a sentence ends right after it", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "built against 1.21.0-rc.1. Nothing else to report.\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.21.0-rc.1" }, "a trailing dot with no digit behind it is punctuation, not another segment")
  })

  it("reports no version at all rather than storing a line that has none in it", async () => {
    const { processProbe } = fakeProbe({
      ok: true,
      stdout: "[Optimum] Shader compatibility scan: sources=48, shaders=12, conflicts=0, failed=False, fingerprint=4f0ab21c73d9e5a180c2b6f47e31a9d8c05be7f21a4d63c8907e5fb2a1d64c3e\n"
    })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: false, reason: "unreadable-version" }, "an unreadable build leaves the field empty for the player to fill in, instead of registering the noise")
  })

  it("never probes twice for one call", async () => {
    const { processProbe, requests } = fakeProbe()

    await detectInstalledGameVersion(fakePorts({ processProbe }), input({ fileNames: ["Vintagestory", "Vintagestory.exe"] }))

    assert.equal(requests.length, 1)
    assert.deepEqual(trace, [`probe:${FOLDER}/Vintagestory -v`])
  })
})

/**
 * A build that names itself.
 *
 * The transcript here is the shape Optimum prints on the `-v` path: its own
 * chatter line, the long game version its IL patch appends the marker to, and
 * the bare game version the client prints last.
 */
const OPTIMUM_TRANSCRIPT = ["[Optimum] Optimum v0.3.14", "1.22.7 + Optimum v0.3.14", "1.22.7", ""].join("\n")

describe("detectInstalledGameVersion build variant", () => {
  it("reads Optimum's own version off the marker, beside the game version", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: OPTIMUM_TRANSCRIPT })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.22.7", variant: { name: "Optimum", version: "0.3.14" } })
  })

  it("never lets the marker version stand in as the game version", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: OPTIMUM_TRANSCRIPT })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.equal(result.ok && result.version, "1.22.7", "0.3.14 is printed first and on a line of its own it is not; the game version is the one printed bare")
  })

  it("leaves the variant key off a vanilla transcript entirely", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "1.22.7\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.22.7" })
    assert.equal("variant" in result, false, "absent, not present and undefined: nothing downstream has to tell the two apart")
  })

  it("does not take a file named Optimum as a build that is one", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "1.22.7\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input({ fileNames: ["Vintagestory", "Optimum"] }))

    assert.deepEqual(result, { ok: true, version: "1.22.7" }, "the packaging script copies file names around; the patched DLL is what prints the marker")
  })

  it("keeps the game version and drops the variant when the marker carries no readable version", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "[Optimum] Optimum vtrunk\n1.22.7\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.22.7" })
  })

  it("reports an unreadable version rather than a variant when the probe printed no version at all", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "[Optimum] Optimum v01.02.03\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: false, reason: "unreadable-version" }, "a variant never substitutes for the number the compatibility checks run on")
  })

  it("refuses a marker version the version grammar accepts and semver does not", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "[Optimum] Optimum v01.02.03\n1.22.7\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.22.7" })
    assert.equal("variant" in result, false, "leading zeros parse as three dotted numbers and are not a version anyone can order")
  })

  it("keeps the game version off the marker when nothing is printed on a line of its own", async () => {
    // What the client prints when it answers -v while the patch path is running:
    // the fork's own number comes first, and no line holds a bare version.
    const stdout = ["[Optimum] Optimum v0.3.14", "[Optimum] Patching VintagestoryLib.dll", "1.22.7 + Optimum v0.3.14", ""].join("\n")
    const { processProbe } = fakeProbe({ ok: true, stdout })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.22.7", variant: { name: "Optimum", version: "0.3.14" } }, "0.3.14 is printed first and is still not the game version")
  })

  it("stays unreadable when the marker is the only version in the output", async () => {
    const { processProbe } = fakeProbe({ ok: true, stdout: "[Optimum] Optimum v0.3.14\nno version here\n" })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: false, reason: "unreadable-version" }, "the fork naming itself is not the game answering")
  })

  it("reads the long version suffix on its own, which is what a warm cache leaves", async () => {
    // On a cache hit the patch path never runs, so the chatter line is absent and
    // the documented LongGameVersion suffix is the only signal left.
    const stdout = ["[Optimum] Cache valid (12ms). Launching...", "1.22.7 + Optimum v0.3.14", ""].join("\n")
    const { processProbe } = fakeProbe({ ok: true, stdout })

    const result = await detectInstalledGameVersion(fakePorts({ processProbe }), input())

    assert.deepEqual(result, { ok: true, version: "1.22.7", variant: { name: "Optimum", version: "0.3.14" } })
  })
})
