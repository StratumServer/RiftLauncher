import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { createInstallation, isValidBackupsLimit, validateInstallationFields } from "../../../src/domain/installations/create"
import type { CreateInstallationInput, CreateInstallationPorts } from "../../../src/domain/installations/create"

function ports(overrides: Partial<CreateInstallationPorts> = {}): CreateInstallationPorts {
  let issued = 0
  return {
    ids: {
      newId: (): string => {
        issued += 1
        return `generated-id-${issued}`
      }
    },
    ...overrides
  }
}

function input(overrides: Partial<CreateInstallationInput> = {}): CreateInstallationInput {
  return {
    name: "My New Installation",
    icon: "icon-1",
    path: "/installations/my-new-installation",
    version: "1.20.4",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    mesaGlThread: false,
    envVars: "",
    foldersInUse: [],
    ...overrides
  }
}

describe("validateInstallationFields", () => {
  it("refuses a name that is too short", () => {
    const result = validateInstallationFields({ name: "abcd", startParams: "" })

    assert.deepEqual(result, { ok: false, reason: "name-length" })
  })

  it("refuses a name that is too long", () => {
    const result = validateInstallationFields({ name: "a".repeat(51), startParams: "" })

    assert.deepEqual(result, { ok: false, reason: "name-length" })
  })

  it("accepts a name right at each bound", () => {
    assert.deepEqual(validateInstallationFields({ name: "a".repeat(5), startParams: "" }), { ok: true })
    assert.deepEqual(validateInstallationFields({ name: "a".repeat(50), startParams: "" }), { ok: true })
  })

  it("refuses start params that carry the launcher's own --dataPath flag", () => {
    const result = validateInstallationFields({ name: "Valid Name", startParams: "--dataPath /somewhere" })

    assert.deepEqual(result, { ok: false, reason: "reserved-start-param" })
  })

  it("checks the name before the start params", () => {
    const result = validateInstallationFields({ name: "abcd", startParams: "--dataPath /somewhere" })

    assert.equal(result.ok === false && result.reason, "name-length")
  })

  it("accepts fields that break neither rule", () => {
    const result = validateInstallationFields({ name: "Valid Name", startParams: "--some-other-flag" })

    assert.deepEqual(result, { ok: true })
  })
})

describe("isValidBackupsLimit", () => {
  it("accepts 0 (backups disabled) and positive integers", () => {
    assert.equal(isValidBackupsLimit(0), true)
    assert.equal(isValidBackupsLimit(1), true)
    assert.equal(isValidBackupsLimit(3), true)
    assert.equal(isValidBackupsLimit(10), true)
  })

  it("refuses negative numbers, fractions, NaN and infinities", () => {
    assert.equal(isValidBackupsLimit(-1), false)
    assert.equal(isValidBackupsLimit(-0.5), false)
    assert.equal(isValidBackupsLimit(1.5), false)
    assert.equal(isValidBackupsLimit(Number.NaN), false)
    assert.equal(isValidBackupsLimit(Number.POSITIVE_INFINITY), false)
    assert.equal(isValidBackupsLimit(Number.NEGATIVE_INFINITY), false)
  })
})

describe("createInstallation", () => {
  it("refuses an invalid name before checking anything else", () => {
    const result = createInstallation(ports(), input({ name: "abcd", path: "/already-used" }))

    assert.deepEqual(result, { ok: false, reason: "name-length" })
  })

  it("refuses start params carrying --dataPath", () => {
    const result = createInstallation(ports(), input({ startParams: "--dataPath /somewhere" }))

    assert.deepEqual(result, { ok: false, reason: "reserved-start-param" })
  })

  it("refuses a folder already in use by a backups folder, installation or version", () => {
    const result = createInstallation(ports(), input({ path: "/games/1.20.4", foldersInUse: ["/backups", "/games/1.20.4"] }))

    assert.deepEqual(result, { ok: false, reason: "folder-in-use" })
  })

  describe("a folder that shares data with one in use", () => {
    const refused = { ok: false, reason: "folder-nested" }

    it("refuses an installation inside another installation", () => {
      assert.deepEqual(createInstallation(ports(), input({ path: "/data/Main/Installations/Modded", foldersInUse: ["/data/Main"] })), refused)
    })

    it("refuses an installation that holds another installation, a version or a nested backups folder", () => {
      assert.deepEqual(createInstallation(ports(), input({ path: "/data", foldersInUse: ["/data/Main"] })), refused)
      assert.deepEqual(createInstallation(ports(), input({ path: "/data", foldersInUse: ["/data/versions/1.20.0"] })), refused)
      assert.deepEqual(createInstallation(ports(), input({ path: "/data/Main", foldersInUse: ["/data/Main/Backups"] })), refused)
    })

    it("refuses an installation inside the backups folder", () => {
      assert.deepEqual(createInstallation(ports(), input({ path: "/backups/Main", foldersInUse: ["/backups"] })), refused)
    })

    it("sees a Windows folder as nested whatever its case and separators", () => {
      assert.deepEqual(createInstallation(ports(), input({ path: "C:\\Data\\MAIN\\Modded", foldersInUse: ["c:/data/main/"] })), refused)
    })

    it("sees two names that differ only by case as one folder on macOS", () => {
      const names = { path: "/Users/p/RL/Installations/creative-world", foldersInUse: ["/Users/p/RL/Installations/Creative-World"] }

      assert.deepEqual(createInstallation(ports(), input({ ...names, platform: "darwin" })), { ok: false, reason: "folder-in-use" })
      assert.equal(createInstallation(ports(), input({ ...names, platform: "posix" })).ok, true)
    })

    it("refuses an installation that is or holds the Installations or VS Versions folder from Config, but takes one inside them", () => {
      const configuredFolders = ["/data/Installations", "/data/Versions"]

      assert.deepEqual(createInstallation(ports(), input({ path: "/data/Installations", configuredFolders })), refused)
      assert.deepEqual(createInstallation(ports(), input({ path: "/data", configuredFolders })), refused)
      assert.deepEqual(createInstallation(ports(), input({ path: "/data/Versions/", configuredFolders })), refused)
      assert.equal(createInstallation(ports(), input({ path: "/data/Installations/Main", configuredFolders })).ok, true)
      assert.equal(createInstallation(ports(), input({ path: "/data/Main", configuredFolders })).ok, true)
      assert.equal(createInstallation(ports(), input({ path: "/data", configuredFolders: ["", ""] })).ok, true)
    })

    it("keeps accepting siblings, even when one name starts with the other", () => {
      assert.equal(createInstallation(ports(), input({ path: "/data/Main2", foldersInUse: ["/data/Main", "/backups"] })).ok, true)
      assert.equal(createInstallation(ports(), input({ path: "/data/Main-copy", foldersInUse: ["/data/Main"] })).ok, true)
    })
  })

  it("builds the record with a generated id and the fixed defaults", () => {
    const result = createInstallation(ports(), input())

    assert.deepEqual(result, {
      ok: true,
      installation: {
        id: "generated-id-1",
        name: "My New Installation",
        icon: "icon-1",
        path: "/installations/my-new-installation",
        version: "1.20.4",
        gameVersionId: null,
        startParams: "",
        backupsLimit: 3,
        backupsAuto: false,
        compressionLevel: 6,
        mesaGlThread: false,
        envVars: "",
        backups: [],
        lastTimePlayed: -1,
        totalTimePlayed: 0
      }
    })
  })

  it("carries the selected game-version id into the new installation", () => {
    const result = createInstallation(ports(), input({ gameVersionId: "gv-optimum" }))

    assert.equal(result.ok && result.installation.gameVersionId, "gv-optimum")
  })

  it("preserves a backupsLimit of 0 on the built installation record", () => {
    const result = createInstallation(ports(), input({ backupsLimit: 0 }))

    assert.equal(result.ok && result.installation.backupsLimit, 0)
  })

  it("mints a fresh id on every call", () => {
    const p = ports()

    const first = createInstallation(p, input())
    const second = createInstallation(p, input({ path: "/installations/another" }))

    assert.equal(first.ok === true && first.installation.id, "generated-id-1")
    assert.equal(second.ok === true && second.installation.id, "generated-id-2")
  })
})
