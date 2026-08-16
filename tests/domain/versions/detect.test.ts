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

  it("never probes twice for one call", async () => {
    const { processProbe, requests } = fakeProbe()

    await detectInstalledGameVersion(fakePorts({ processProbe }), input({ fileNames: ["Vintagestory", "Vintagestory.exe"] }))

    assert.equal(requests.length, 1)
    assert.deepEqual(trace, [`probe:${FOLDER}/Vintagestory -v`])
  })
})
