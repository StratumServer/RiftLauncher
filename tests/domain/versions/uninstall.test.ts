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

function ports(options: { removed?: boolean; present?: boolean } = {}): UninstallGameVersionPorts {
  return {
    fileSystem: {
      exists: async (path: string): Promise<boolean> => {
        trace.push(`exists:${path}`)
        return options.present ?? true
      },
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
    assert.deepEqual(trace, ["started", "exists:/games/1.20.4", "remove:/games/1.20.4", "finished"])
  })

  it("refuses before any deletion when installations use it and that isn't confirmed", async () => {
    const result = await uninstallGameVersion(ports(), input({ usedByInstallations: ["Survival World", "Creative Sandbox"], confirmedInUse: false }), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "version-in-use" })
    assert.deepEqual(trace, [])
  })

  it("proceeds once the in-use warning is confirmed", async () => {
    const result = await uninstallGameVersion(ports(), input({ usedByInstallations: ["Survival World"], confirmedInUse: true }), recordingEvents())

    assert.deepEqual(result, { ok: true, folderRemoved: true })
    assert.deepEqual(trace, ["started", "exists:/games/1.20.4", "remove:/games/1.20.4", "finished"])
  })
})

describe("uninstallGameVersion", () => {
  it("removes the version folder and reports success", async () => {
    const hosts = ports()

    const result = await uninstallGameVersion(hosts, input(), recordingEvents())

    assert.deepEqual(result, { ok: true, folderRemoved: true })
    assert.deepEqual(trace, ["started", "exists:/games/1.20.4", "remove:/games/1.20.4", "finished"])
  })

  it("reports a failed folder deletion so the version stays on the list", async () => {
    const result = await uninstallGameVersion(ports({ removed: false }), input(), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "file-delete-failed" })
    assert.deepEqual(trace, ["started", "exists:/games/1.20.4", "remove:/games/1.20.4", "finished"])
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
    assert.deepEqual(trace, ["started", "exists:/games/1.20.4", "remove:/games/1.20.4", "finished"])
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

/**
 * A row whose folder is not there (an install cut off before its first byte landed (#710), a folder
 * the player deleted by hand, a drive that is unplugged, an uninstall cut off before the list was
 * saved) is dropped without asking the host to delete it. The host refuses to delete a path it
 * cannot find, so without this the row could be neither played nor removed.
 */
describe("uninstallGameVersion when the folder is gone", () => {
  it("drops the row of a version whose folder is gone, without asking the host to delete it", async () => {
    const result = await uninstallGameVersion(ports({ present: false, removed: false }), input(), recordingEvents())

    assert.deepEqual(result, { ok: true, folderRemoved: true })
    assert.deepEqual(trace, ["started", "exists:/games/1.20.4", "finished"])
  })

  it("keeps a version on the list when its folder is there and cannot be deleted", async () => {
    const result = await uninstallGameVersion(ports({ present: true, removed: false }), input(), recordingEvents())

    assert.deepEqual(result, { ok: false, reason: "file-delete-failed" })
    assert.deepEqual(trace, ["started", "exists:/games/1.20.4", "remove:/games/1.20.4", "finished"])
  })

  it("lets the same version go the next time after its folder was removed but the list was not saved", async () => {
    const first = await uninstallGameVersion(ports({ present: false }), input({ usedByInstallations: ["Survival World"], confirmedInUse: true }), recordingEvents())
    const again = await uninstallGameVersion(ports({ present: false }), input({ usedByInstallations: ["Survival World"], confirmedInUse: true }), recordingEvents())

    assert.deepEqual(
      [first, again],
      [
        { ok: true, folderRemoved: true },
        { ok: true, folderRemoved: true }
      ]
    )
    assert.equal(
      trace.some((entry) => entry.startsWith("remove:")),
      false
    )
  })

  it("leaves the verdict to the delete when the folder check itself fails", async () => {
    const failing: UninstallGameVersionPorts = {
      fileSystem: {
        exists: async (): Promise<boolean> => {
          throw new Error("Unmanaged path")
        },
        remove: async (path: string): Promise<boolean> => {
          trace.push(`remove:${path}`)
          return false
        }
      }
    }

    const result = await uninstallGameVersion(failing, input())

    assert.deepEqual(result, { ok: false, reason: "file-delete-failed" })
    assert.deepEqual(trace, ["remove:/games/1.20.4"])
  })
})
