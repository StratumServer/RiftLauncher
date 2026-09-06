import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { toModpackManifest } from "../../src/renderer/src/features/mods/adapters/importModpack"
import { MAX_MODPACK_MOD_NAME_LENGTH } from "../../src/domain/mods/importModpack"

function installation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "main",
    name: "Main",
    icon: "",
    path: "/installations/main",
    version: "1.20.4",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: 0,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    ...overrides
  }
}

function installedMod(overrides: Partial<InstalledModType> = {}): InstalledModType {
  return { name: "Traders Expansion", modid: "tradie", version: "1.4.0", path: "/installations/main/Mods/tradie-1.4.0.zip", enabled: true, ...overrides }
}

describe("toModpackManifest", () => {
  it("writes the local display name next to every modid, which is the only name an unresolvable entry ever gets (#379)", () => {
    const manifest = toModpackManifest(installation(), [installedMod(), installedMod({ name: "Sammiches", modid: "sandwich", version: "2.1.0" })])

    assert.deepEqual(manifest.mods, [
      { modid: "tradie", version: "1.4.0", name: "Traders Expansion" },
      { modid: "sandwich", version: "2.1.0", name: "Sammiches" }
    ])
  })

  it("names the pack after the installation and pins its game version", () => {
    const manifest = toModpackManifest(installation({ name: "Co-op pack", version: "1.19.8" }), [])

    assert.deepEqual(manifest, { name: "Co-op pack", gameVersion: "1.19.8", mods: [] })
  })

  // #384: a modinfo.json name can run up to the scanner's own 4096-character cap, well past the
  // 256 the manifest reader accepts. Copying it verbatim used to fail the whole export over one
  // label; the writer now clamps it so the export always succeeds.
  it("clamps a mod name over the manifest reader's cap instead of failing the export on it", () => {
    const longName = "A".repeat(MAX_MODPACK_MOD_NAME_LENGTH + 200)
    const manifest = toModpackManifest(installation(), [installedMod({ name: longName })])

    assert.equal(manifest.mods[0]?.name?.length, MAX_MODPACK_MOD_NAME_LENGTH)
    assert.equal(manifest.mods[0]?.name, "A".repeat(MAX_MODPACK_MOD_NAME_LENGTH))
  })

  it("leaves a name at or under the cap exactly as it was read off disk", () => {
    const manifest = toModpackManifest(installation(), [installedMod({ name: "Traders Expansion" })])

    assert.equal(manifest.mods[0]?.name, "Traders Expansion")
  })
})
