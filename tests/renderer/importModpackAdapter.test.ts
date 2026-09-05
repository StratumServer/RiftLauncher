import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { toModpackManifest } from "../../src/renderer/src/features/mods/adapters/importModpack"

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
})
