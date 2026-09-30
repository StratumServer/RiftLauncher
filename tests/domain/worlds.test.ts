import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { MAX_WORLDS, canTransferWorld, collisionFreeWorldName, hasWorldSidecars, isSafeWorldName, listWorlds, worldSidecarNames, worldVersionWarning } from "@domain/worlds/worlds"

describe("world domain", () => {
  it("lists only safe vcdb worlds, newest first, with a hard cap", () => {
    const worlds = listWorlds([
      { name: "old.vcdbs", size: 1, lastModified: 1, isDefault: false, backupCount: 0 },
      { name: "default.vcdbs", size: 2, lastModified: 2, isDefault: true, backupCount: 1 },
      { name: "Mods", size: 3, lastModified: 3, isDefault: false, backupCount: 0 },
      { name: "../escape.vcdbs", size: 4, lastModified: 4, isDefault: false, backupCount: 0 },
      ...Array.from({ length: MAX_WORLDS + 4 }, (_, index) => ({ name: `world-${index}.vcdbs`, size: 1, lastModified: index + 10, isDefault: false, backupCount: 0 }))
    ])

    assert.equal(worlds.length, MAX_WORLDS)
    assert.equal(worlds[0]?.name, `world-${MAX_WORLDS + 3}.vcdbs`)
    assert.equal(
      worlds.some((world) => world.name === "Mods"),
      false
    )
    assert.equal(
      worlds.some((world) => world.name.includes("escape")),
      false
    )
  })

  it("rejects separators, sidecars, and extension-only names", () => {
    assert.equal(isSafeWorldName("world.vcdbs"), true)
    assert.equal(isSafeWorldName("world.VCDBS"), true)
    assert.equal(isSafeWorldName(".vcdbs"), false)
    assert.equal(isSafeWorldName("../world.vcdbs"), false)
    assert.equal(isSafeWorldName("world.vcdbs-wal"), false)
    assert.equal(isSafeWorldName("CON.vcdbs"), false)
    assert.equal(isSafeWorldName("world.vcdbs "), false)
    assert.equal(isSafeWorldName("world\u0001.vcdbs"), false)
    assert.deepEqual(worldSidecarNames("world.vcdbs"), ["world.vcdbs-wal", "world.vcdbs-shm"])
    assert.equal(hasWorldSidecars(["world.vcdbs", "world.vcdbs-wal"], "world.vcdbs"), true)
  })

  it("chooses a deterministic collision suffix and warns on version changes", () => {
    assert.equal(collisionFreeWorldName("A.vcdbs", ["A.vcdbs", "A (2).vcdbs"]), "A (3).vcdbs")
    assert.equal(collisionFreeWorldName("B.vcdbs", []), "B.vcdbs")
    assert.equal(collisionFreeWorldName("B.vcdbs", ["b.VCDBS"]), "B (2).vcdbs")
    assert.equal(worldVersionWarning("1.20.0", "1.21.0"), "different-version")
    assert.equal(worldVersionWarning("1.20.0", "1.20.0"), undefined)
    assert.equal(canTransferWorld("a", "b"), true)
    assert.equal(canTransferWorld("a", "a"), false)
  })
})
