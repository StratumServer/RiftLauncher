import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { createInstallation, validateInstallationFields } from "../../../src/domain/installations/create"
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

  it("mints a fresh id on every call", () => {
    const p = ports()

    const first = createInstallation(p, input())
    const second = createInstallation(p, input({ path: "/installations/another" }))

    assert.equal(first.ok === true && first.installation.id, "generated-id-1")
    assert.equal(second.ok === true && second.installation.id, "generated-id-2")
  })
})
