import assert from "node:assert/strict"
import { describe, it } from "vitest"

import type { OptimumManifest } from "@domain/optimum/manifest"
import { cliFileName, hostRid, isUpdateAvailable, overlayCacheFolder, overlayDownloadUrl, overlayFolderName, patchArgs, rollbackArgs, supportsGameVersion } from "@domain/optimum/plan"

function manifest(overrides: Partial<OptimumManifest> = {}): OptimumManifest {
  return {
    manifestVersion: 1,
    optimumVersion: "0.3.14",
    supportedGameVersions: ["1.22.7"],
    rid: "linux-x64",
    archive: { filename: "Optimum-v0.3.14-linux-x64-overlay.tar.gz", size: 10, sha256: "a".repeat(64) },
    targets: [],
    files: [{ path: "optimum", size: 10, sha256: "b".repeat(64) }],
    ...overrides
  }
}

describe("hostRid", () => {
  it("names the two platforms an overlay is published for", () => {
    assert.equal(hostRid("linux", "x64"), "linux-x64")
    assert.equal(hostRid("win32", "x64"), "win-x64")
  })

  it("has nothing for macOS or for a non-x64 machine", () => {
    assert.equal(hostRid("darwin", "x64"), undefined)
    assert.equal(hostRid("darwin", "arm64"), undefined)
    assert.equal(hostRid("linux", "arm64"), undefined)
    assert.equal(hostRid("win32", "ia32"), undefined)
  })
})

describe("supportsGameVersion", () => {
  it("answers on the list the manifest publishes", () => {
    assert.equal(supportsGameVersion(manifest(), "1.22.7"), true)
    assert.equal(supportsGameVersion(manifest(), "1.22.6"), false)
  })

  it("refuses anything that is not a version rather than matching it as text", () => {
    assert.equal(supportsGameVersion(manifest(), "1.22"), false)
    assert.equal(supportsGameVersion(manifest(), ""), false)
  })
})

describe("isUpdateAvailable", () => {
  it("offers a newer overlay that still supports the installed build", () => {
    assert.equal(isUpdateAvailable("0.3.13", "1.22.7", manifest()), true)
  })

  it("offers nothing when the published overlay is the one installed", () => {
    assert.equal(isUpdateAvailable("0.3.14", "1.22.7", manifest()), false)
  })

  it("offers nothing when the published overlay is older", () => {
    assert.equal(isUpdateAvailable("0.4.0", "1.22.7", manifest()), false)
  })

  it("offers nothing when the newer overlay dropped that game version", () => {
    assert.equal(isUpdateAvailable("0.3.13", "1.22.7", manifest({ optimumVersion: "0.4.0", supportedGameVersions: ["1.23.0"] })), false)
  })

  it("offers nothing when the installed overlay version is unreadable", () => {
    assert.equal(isUpdateAvailable("", "1.22.7", manifest()), false)
    assert.equal(isUpdateAvailable("unknown", "1.22.7", manifest()), false)
  })
})

describe("addresses built by the launcher", () => {
  it("builds the download URL from the version and the checked file name", () => {
    assert.equal(overlayDownloadUrl(manifest()), "https://github.com/StratumServer/Optimum/releases/download/v0.3.14/Optimum-v0.3.14-linux-x64-overlay.tar.gz")
  })

  it("names one cache folder per version and platform, and the folder the archive unpacks into", () => {
    assert.equal(overlayCacheFolder(manifest()), "0.3.14-linux-x64")
    assert.equal(overlayCacheFolder(manifest({ rid: "win-x64" })), "0.3.14-win-x64")
    assert.equal(overlayFolderName(manifest()), "Optimum-v0.3.14-linux-x64-overlay")
  })

  it("names the CLI per platform", () => {
    assert.equal(cliFileName("linux"), "optimum")
    assert.equal(cliFileName("win32"), "optimum.exe")
  })
})

describe("the CLI argument list", () => {
  it("passes both paths absolute and asks for JSON", () => {
    const args = patchArgs("/versions/1.22.7", "/cache/Optimum/0.3.14-linux-x64/Optimum-v0.3.14-linux-x64-overlay")

    assert.deepEqual(args, ["patch", "--game-dir", "/versions/1.22.7", "--overlay", "/cache/Optimum/0.3.14-linux-x64/Optimum-v0.3.14-linux-x64-overlay", "--json"])
  })

  it("never asks for a run without a backup", () => {
    // Without .optimum/vanilla/ the second run patches an already-patched
    // assembly, so an update would compound instead of converging.
    assert.equal(patchArgs("/game", "/overlay").includes("--no-backup"), false)
    assert.equal(rollbackArgs("/game").includes("--no-backup"), false)
  })

  it("asks for the rollback with the game folder alone", () => {
    assert.deepEqual(rollbackArgs("/versions/1.22.7"), ["patch", "--game-dir", "/versions/1.22.7", "--rollback", "--json"])
  })
})
