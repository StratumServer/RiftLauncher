import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { uninstallGameVersion } from "../../../src/domain/versions/uninstall"
import type { GameVersionSnapshot, UninstallGameVersionEvents, UninstallGameVersionInput, UninstallGameVersionPorts } from "../../../src/domain/versions/uninstall"

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

function version(overrides: Partial<GameVersionSnapshot> = {}): GameVersionSnapshot {
  return { version: "1.20.4", path: "/games/1.20.4", isPlaying: false, isDeleting: false, linked: false, ...overrides }
}

function input(overrides: Partial<Omit<UninstallGameVersionInput, "version">> & { version?: GameVersionSnapshot } = {}): UninstallGameVersionInput {
  const { version: versionOverride, ...rest } = overrides
  return { version: versionOverride ?? version(), usedByInstallations: [], confirmedInUse: false, ...rest }
}

function ports(options: { removed?: boolean } = {}): UninstallGameVersionPorts {
  return {
    fileSystem: {
      remove: async (path: string): Promise<boolean> => {
        trace.push(`remove:${path}`)
        return options.removed ?? true
      }
    }
  }
}

function recordingEvents(): UninstallGameVersionEvents {
  return {
    onStarted: (): void => {
      trace.push("started")
    },
    onFinished: (): void => {
      trace.push("finished")
    }
  }
}

beforeEach(() => {
  trace = []
})

describe("uninstallGameVersion preconditions", () => {
  it("refuses a version that is being played", async () => {
    const result = await uninstallGameVersion(ports(), input({ version: version({ isPlaying: true }) }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "version-playing" })
    assert.deepEqual(trace, [])
  })

  it("refuses a version that is already being deleted", async () => {
    const result = await uninstallGameVersion(ports(), input({ version: version({ isDeleting: true }) }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "version-busy" })
    assert.deepEqual(trace, [])
  })

  it("checks isPlaying before isDeleting", async () => {
    const result = await uninstallGameVersion(ports(), input({ version: version({ isPlaying: true, isDeleting: true }) }))

    assert.equal(result.ok === false && result.reason, "version-playing")
  })
})

describe("uninstallGameVersion in-use confirmation", () => {
  it("needs no confirmation when no installation uses the version", async () => {
    const result = await uninstallGameVersion(ports(), input({ usedByInstallations: [], confirmedInUse: false }), recordingEvents())

    assert.deepEqual(result, { ok: true, folderRemoved: true })
    assert.deepEqual(trace, ["started", "remove:/games/1.20.4", "finished"])
  })

  it("refuses before any deletion when installations use it and that isn't confirmed", async () => {
    const result = await uninstallGameVersion(ports(), input({ usedByInstallations: ["Survival World", "Creative Sandbox"], confirmedInUse: false }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "version-in-use" })
    assert.deepEqual(trace, [])
  })

  it("proceeds once the in-use warning is confirmed", async () => {
    const result = await uninstallGameVersion(ports(), input({ usedByInstallations: ["Survival World"], confirmedInUse: true }), recordingEvents())

    assert.deepEqual(result, { ok: true, folderRemoved: true })
    assert.deepEqual(trace, ["started", "remove:/games/1.20.4", "finished"])
  })
})

describe("uninstallGameVersion", () => {
  it("removes the version folder and reports success", async () => {
    const hosts = ports()

    const result = await uninstallGameVersion(hosts, input(), recordingEvents())

    assert.deepEqual(result, { ok: true, folderRemoved: true })
    assert.deepEqual(trace, ["started", "remove:/games/1.20.4", "finished"])
  })

  it("reports a failed folder deletion so the version stays on the list", async () => {
    const result = await uninstallGameVersion(ports({ removed: false }), input(), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "file-delete-failed" })
    assert.deepEqual(trace, ["started", "remove:/games/1.20.4", "finished"])
  })

  it("fires onFinished even when the deletion fails", async () => {
    await uninstallGameVersion(ports({ removed: false }), input(), recordingEvents())

    assert.equal(trace.includes("finished"), true)
  })

  it("works without events", async () => {
    const result = await uninstallGameVersion(ports(), input())

    assert.deepEqual(result, { ok: true, folderRemoved: true })
  })
})

describe("uninstallGameVersion linked versions", () => {
  it("unregisters a linked version without touching its folder", async () => {
    const hosts = ports()

    const result = await uninstallGameVersion(hosts, input({ version: version({ linked: true }) }), recordingEvents())

    assert.deepEqual(result, { ok: true, folderRemoved: false })
    assert.deepEqual(trace, ["started", "finished"])
  })

  it("still calls remove for a version that was never linked", async () => {
    const hosts = ports()

    const result = await uninstallGameVersion(hosts, input({ version: version({ linked: false }) }), recordingEvents())

    assert.deepEqual(result, { ok: true, folderRemoved: true })
    assert.deepEqual(trace, ["started", "remove:/games/1.20.4", "finished"])
  })

  it("refuses a linked version that is being played, same as any other", async () => {
    const result = await uninstallGameVersion(ports(), input({ version: version({ linked: true, isPlaying: true }) }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "version-playing" })
    assert.deepEqual(trace, [])
  })

  it("refuses a linked version still used by installations when that isn't confirmed", async () => {
    const result = await uninstallGameVersion(ports(), input({ version: version({ linked: true }), usedByInstallations: ["Survival World"], confirmedInUse: false }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "version-in-use" })
    assert.deepEqual(trace, [])
  })
})
