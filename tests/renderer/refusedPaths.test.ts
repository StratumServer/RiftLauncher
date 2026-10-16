import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { CONFIG_ACTIONS, configReducer, initialState } from "../../src/renderer/src/features/config/contexts/configReducer"
import { dropRefusedPaths } from "../../src/renderer/src/features/config/utils/refusedPaths"

function installation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-1",
    name: "Survival",
    icon: "",
    path: "/installs/survival",
    version: "1.21.5",
    gameVersionId: "gv-1",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 4,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    ...overrides
  }
}

function aConfig(overrides: Partial<ConfigType> = {}): ConfigType {
  return {
    ...initialState,
    defaultInstallationsFolder: "/installs",
    defaultVersionsFolder: "/versions",
    backupsFolder: "/backups",
    gameVersions: [
      { id: "gv-1", version: "1.21.5", label: "Mine", path: "/games/mine" },
      { id: "gv-2", version: "1.21.0", label: "", path: "/versions/1.21.0" }
    ],
    installations: [installation()],
    ...overrides
  }
}

const KEPT = { defaultInstallationsFolder: "/old/installs", defaultVersionsFolder: "/old/versions", backupsFolder: "/old/backups" }

describe("dropRefusedPaths", () => {
  it("hands back the same state when nothing in it was refused", () => {
    const config = aConfig()
    const result = dropRefusedPaths(config, ["/somewhere/else"], KEPT)
    assert.equal(result.config, config)
    assert.deepEqual(result.names, [])
  })

  it("drops a refused VS Version and names it by its label, or its version when it has none", () => {
    const result = dropRefusedPaths(aConfig(), ["/games/mine", "/versions/1.21.0"], null)
    assert.deepEqual(result.config.gameVersions, [])
    assert.deepEqual(result.names, ["Mine", "1.21.0"])
    assert.equal(result.config.installations.length, 1)
  })

  it("drops a refused Installation and names it", () => {
    const result = dropRefusedPaths(aConfig(), ["/installs/survival"], null)
    assert.deepEqual(result.config.installations, [])
    assert.deepEqual(result.names, ["Survival"])
    assert.equal(result.config.gameVersions.length, 2)
  })

  it("drops a refused backup or world backup from its Installation and keeps the Installation", () => {
    const config = aConfig({
      installations: [
        installation({
          backups: [
            { id: "b1", date: 1, path: "/elsewhere/b1.tar.gz" },
            { id: "b2", date: 2, path: "/backups/b2.tar.gz" }
          ],
          worldBackups: [{ id: "w1", date: 3, path: "/elsewhere/w1.tar.gz", worldName: "Default" }]
        })
      ]
    })
    const result = dropRefusedPaths(config, ["/elsewhere/b1.tar.gz", "/elsewhere/w1.tar.gz"], null)
    assert.deepEqual(
      result.config.installations[0]?.backups.map((backup) => backup.id),
      ["b2"]
    )
    assert.deepEqual(result.config.installations[0]?.worldBackups, [])
    assert.deepEqual(result.names, ["/elsewhere/b1.tar.gz", "/elsewhere/w1.tar.gz"])
  })

  it("sends a refused folder setting back to the one main holds, and names the folder", () => {
    const result = dropRefusedPaths(aConfig({ defaultVersionsFolder: "/picked/versions" }), ["/picked/versions"], KEPT)
    assert.equal(result.config.defaultVersionsFolder, "/old/versions")
    assert.equal(result.config.defaultInstallationsFolder, "/installs")
    assert.deepEqual(result.names, ["/picked/versions"])
  })

  it("leaves a refused folder setting alone when main holds the same folder, since sending it back changes nothing", () => {
    const config = aConfig({ backupsFolder: "/old/backups" })
    const result = dropRefusedPaths(config, ["/old/backups"], KEPT)
    assert.equal(result.config, config)
    assert.deepEqual(result.names, [])
  })

  it("leaves a refused folder setting alone when main's folders could not be read", () => {
    const config = aConfig({ backupsFolder: "/picked/backups" })
    const result = dropRefusedPaths(config, ["/picked/backups"], null)
    assert.equal(result.config, config)
    assert.deepEqual(result.names, [])
  })
})

describe("configReducer DROP_REFUSED_PATHS", () => {
  it("applies dropRefusedPaths to the state", () => {
    const next = configReducer(aConfig(), { type: CONFIG_ACTIONS.DROP_REFUSED_PATHS, payload: { paths: ["/games/mine"], kept: null } })
    assert.deepEqual(
      next.gameVersions.map((gameVersion) => gameVersion.id),
      ["gv-2"]
    )
  })
})
