import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { uninstallGameVersion } from "../../../src/domain/versions/uninstall"
import type { GameVersionSnapshot, UninstallGameVersionEvents, UninstallGameVersionPorts } from "../../../src/domain/versions/uninstall"

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

function version(overrides: Partial<GameVersionSnapshot> = {}): GameVersionSnapshot {
  return { version: "1.20.4", path: "/games/1.20.4", isPlaying: false, isDeleting: false, ...overrides }
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
    const result = await uninstallGameVersion(ports(), { version: version({ isPlaying: true }) }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "version-playing" })
    assert.deepEqual(trace, [])
  })

  it("refuses a version that is already being deleted", async () => {
    const result = await uninstallGameVersion(ports(), { version: version({ isDeleting: true }) }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "version-busy" })
    assert.deepEqual(trace, [])
  })

  it("checks isPlaying before isDeleting", async () => {
    const result = await uninstallGameVersion(ports(), { version: version({ isPlaying: true, isDeleting: true }) })

    assert.equal(result.ok === false && result.reason, "version-playing")
  })
})

describe("uninstallGameVersion", () => {
  it("removes the version folder and reports success", async () => {
    const hosts = ports()

    const result = await uninstallGameVersion(hosts, { version: version() }, recordingEvents())

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(trace, ["started", "remove:/games/1.20.4", "finished"])
  })

  it("reports a failed folder deletion so the version stays on the list", async () => {
    const result = await uninstallGameVersion(ports({ removed: false }), { version: version() }, recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "file-delete-failed" })
    assert.deepEqual(trace, ["started", "remove:/games/1.20.4", "finished"])
  })

  it("fires onFinished even when the deletion fails", async () => {
    await uninstallGameVersion(ports({ removed: false }), { version: version() }, recordingEvents())

    assert.equal(trace.includes("finished"), true)
  })

  it("works without events", async () => {
    const result = await uninstallGameVersion(ports(), { version: version() })

    assert.deepEqual(result, { ok: true })
  })
})
