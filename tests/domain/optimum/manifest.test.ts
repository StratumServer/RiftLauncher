import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { parseOptimumManifest } from "@domain/optimum/manifest"

const HASH = `sha256:${"a".repeat(64)}`
const FILE_HASH = `sha256:${"b".repeat(64)}`

/** A manifest exactly as `scripts/package-overlay.sh` writes the sidecar copy, trimmed to what the launcher reads. */
function goodManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    optimumVersion: "0.3.14",
    supportedGameVersions: ["1.22.7"],
    rid: "linux-x64",
    archive: { filename: "Optimum-v0.3.14-linux-x64-overlay.tar.gz", size: 38_000_000, sha256: HASH },
    targets: [
      { assembly: "VintagestoryLib.dll", donor: ".optimum/donors/VintagestoryLib.Donor.dll", mode: "transplant" },
      { assembly: "VintagestoryAPI.dll", donor: ".optimum/donors/VintagestoryAPI.Contracts.dll", mode: "api" },
      { assembly: "Mods/VSEssentials.dll", donor: ".optimum/donors/VSEssentials.Donor.dll", mode: "mod", modName: "vsessentials" },
      { assembly: "Mods/VSSurvivalMod.dll", donor: ".optimum/donors/VSSurvivalMod.Donor.dll", mode: "mod", modName: "vssurvivalmod" }
    ],
    files: [
      { path: "optimum", size: 72_000, sha256: FILE_HASH },
      { path: ".optimum/donors/VintagestoryLib.Donor.dll", size: 4_000_000, sha256: FILE_HASH }
    ],
    ...overrides
  }
}

function parse(document: Record<string, unknown>): ReturnType<typeof parseOptimumManifest> {
  return parseOptimumManifest(JSON.stringify(document))
}

describe("parseOptimumManifest", () => {
  it("reads a well-formed manifest and strips the sha256 prefix", () => {
    const manifest = parse(goodManifest())

    assert.ok(manifest)
    assert.equal(manifest.optimumVersion, "0.3.14")
    assert.equal(manifest.rid, "linux-x64")
    assert.deepEqual(manifest.supportedGameVersions, ["1.22.7"])
    assert.equal(manifest.archive.filename, "Optimum-v0.3.14-linux-x64-overlay.tar.gz")
    assert.equal(manifest.archive.sha256, "a".repeat(64))
    assert.equal(manifest.files.length, 2)
    assert.equal(manifest.files[0]?.sha256, "b".repeat(64))
    assert.equal(manifest.targets.length, 4)
    assert.equal(manifest.targets[2]?.modName, "vsessentials")
  })

  it("never reads the two per-target hashes, which the packaging script does not write", () => {
    const manifest = parse(
      goodManifest({
        targets: [{ assembly: "VintagestoryLib.dll", donor: "d.dll", mode: "transplant", expectedInputSha256: HASH, expectedOutputSha256: HASH }]
      })
    )

    assert.ok(manifest)
    assert.deepEqual(manifest.targets, [{ assembly: "VintagestoryLib.dll", donor: "d.dll", mode: "transplant" }])
  })

  for (const [label, text] of [
    ["text that is not JSON", "not json"],
    ["a truncated document", '{"manifestVersion":1,"optimumVersion":"0.3'],
    ["a document that is not an object", '"hello"'],
    ["an array", "[]"]
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.equal(parseOptimumManifest(text), undefined)
    })
  }

  for (const [label, overrides] of [
    ["a manifest version this build does not know", { manifestVersion: 2 }],
    ["a missing manifest version", { manifestVersion: undefined }],
    ["an Optimum version that is not a version", { optimumVersion: "latest" }],
    ["an unknown runtime identifier", { rid: "osx-arm64" }],
    ["no supported game version left after the bad ones are dropped", { supportedGameVersions: ["not-a-version"] }],
    ["an empty supported game version list", { supportedGameVersions: [] }],
    ["an archive name that does not match the version", { archive: { filename: "Optimum-v0.3.13-linux-x64-overlay.tar.gz", size: 10, sha256: HASH } }],
    ["an archive name that does not match the platform", { archive: { filename: "Optimum-v0.3.14-win-x64-overlay.tar.gz", size: 10, sha256: HASH } }],
    ["a malformed archive hash", { archive: { filename: "Optimum-v0.3.14-linux-x64-overlay.tar.gz", size: 10, sha256: "a".repeat(64) } }],
    ["an uppercase archive hash", { archive: { filename: "Optimum-v0.3.14-linux-x64-overlay.tar.gz", size: 10, sha256: `sha256:${"A".repeat(64)}` } }],
    ["an archive of no bytes", { archive: { filename: "Optimum-v0.3.14-linux-x64-overlay.tar.gz", size: 0, sha256: HASH } }],
    ["an archive past the size ceiling", { archive: { filename: "Optimum-v0.3.14-linux-x64-overlay.tar.gz", size: 513 * 1024 * 1024, sha256: HASH } }],
    ["a file list with nothing usable left in it", { files: [{ path: "../escape", size: 1, sha256: FILE_HASH }] }],
    ["an empty file list", { files: [] }]
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.equal(parse(goodManifest(overrides as Record<string, unknown>)), undefined)
    })
  }

  for (const path of ["../escape", "nested/../../escape", "/absolute", "windows\\separator", "trailing/", "", "."]) {
    it(`drops the file entry whose path is ${JSON.stringify(path)}`, () => {
      const manifest = parse(
        goodManifest({
          files: [
            { path, size: 1, sha256: FILE_HASH },
            { path: "optimum", size: 2, sha256: FILE_HASH }
          ]
        })
      )

      assert.ok(manifest)
      assert.deepEqual(
        manifest.files.map((file) => file.path),
        ["optimum"]
      )
    })
  }

  it("keeps the good entries when one file entry is malformed", () => {
    const manifest = parse(
      goodManifest({
        files: [
          { path: "optimum", size: 10, sha256: FILE_HASH },
          { path: "patcher/Optimum.Patcher.dll", size: -1, sha256: FILE_HASH },
          { path: "assets/game/lang/en.json", size: 0, sha256: FILE_HASH }
        ]
      })
    )

    assert.ok(manifest)
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["optimum", "assets/game/lang/en.json"]
    )
  })

  it("drops a target it cannot read rather than the whole document", () => {
    const manifest = parse(goodManifest({ targets: [{ assembly: "../escape.dll", donor: "d.dll", mode: "transplant" }, { assembly: "VintagestoryLib.dll", donor: "d.dll", mode: "transplant" }, 7] }))

    assert.ok(manifest)
    assert.deepEqual(
      manifest.targets.map((target) => target.assembly),
      ["VintagestoryLib.dll"]
    )
  })

  it("keeps only the game versions that are versions", () => {
    const manifest = parse(goodManifest({ supportedGameVersions: ["1.22.7", "latest", 7, "1.23.0-rc.1"] }))

    assert.ok(manifest)
    assert.deepEqual(manifest.supportedGameVersions, ["1.22.7", "1.23.0-rc.1"])
  })
})
