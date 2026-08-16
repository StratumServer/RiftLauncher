import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import { requestBoundedText } from "@src/ipc/network"

/**
 * The session's record of which downloaded artifacts were verified, and the
 * lookup of the official hash they are checked against.
 *
 * This is what stands between a downloaded installer and being executed: the
 * launcher only runs an installer it fetched and hashed itself, in this
 * session, and re-hashes it immediately before the run in case something
 * swapped the file in between. Both halves were at 7%.
 *
 * `requestBoundedText` is mocked at the module boundary, so no test reaches
 * api.vintagestory.at. The manifest cache and the verified-artifact map are
 * module state, which is why every test re-imports through `loadVerification()`
 * after `vi.resetModules()`.
 */
vi.mock("@src/ipc/network", () => ({
  requestBoundedText: vi.fn()
}))

type ArtifactVerification = typeof import("@src/ipc/artifactVerification")

const STABLE_MANIFEST_URL = "https://api.vintagestory.at/stable.json"
const UNSTABLE_MANIFEST_URL = "https://api.vintagestory.at/unstable.json"
const CDN_URL = "https://cdn.vintagestory.at/gamefiles/stable/vs_setup_1.22.6.exe"

let workspace: string

/** A verification module with an empty record and an empty manifest cache. */
async function loadVerification(): Promise<ArtifactVerification> {
  vi.resetModules()
  return await import("@src/ipc/artifactVerification")
}

/** Answers each manifest URL with the body given, and anything else with a 404-shaped failure. */
function serveManifests(stable: unknown, unstable: unknown = {}): void {
  vi.mocked(requestBoundedText).mockImplementation(async (url) => {
    if (url.toString() === STABLE_MANIFEST_URL) return JSON.stringify(stable)
    if (url.toString() === UNSTABLE_MANIFEST_URL) return JSON.stringify(unstable)
    throw new Error(`unexpected request for ${url.toString()}`)
  })
}

function writeArtifact(name: string, contents: string): { path: string; md5: string } {
  const path = join(workspace, name)
  writeFileSync(path, contents)
  return { path, md5: createHash("md5").update(contents).digest("hex") }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-artifact-verification-test-"))
  vi.mocked(requestBoundedText).mockReset()
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("calculateMd5", () => {
  it("hashes a file's contents", async () => {
    const { calculateMd5 } = await loadVerification()
    const artifact = writeArtifact("installer.exe", "the installer bytes")

    assert.equal(await calculateMd5(artifact.path), artifact.md5)
  })

  it("hashes a file too large for one chunk", async () => {
    const { calculateMd5 } = await loadVerification()
    const artifact = writeArtifact("large.exe", "x".repeat(256 * 1024))

    assert.equal(await calculateMd5(artifact.path), artifact.md5)
  })

  it("rejects for a file that is not there", async () => {
    const { calculateMd5 } = await loadVerification()

    await assert.rejects(calculateMd5(join(workspace, "never-downloaded.exe")))
  })
})

describe("recordVerifiedArtifact and assertVerifiedArtifact", () => {
  it("accepts an artifact whose digest matches what was recorded", async () => {
    const { recordVerifiedArtifact, assertVerifiedArtifact } = await loadVerification()
    const artifact = writeArtifact("installer.exe", "the installer bytes")

    await recordVerifiedArtifact(artifact.path, new URL(CDN_URL), artifact.md5)

    await assert.doesNotReject(assertVerifiedArtifact(artifact.path))
  })

  it("accepts a hash the manifest spelled in upper case", async () => {
    const { recordVerifiedArtifact, assertVerifiedArtifact } = await loadVerification()
    const artifact = writeArtifact("installer.exe", "the installer bytes")

    await recordVerifiedArtifact(artifact.path, new URL(CDN_URL), artifact.md5.toUpperCase())

    await assert.doesNotReject(assertVerifiedArtifact(artifact.path))
  })

  it("refuses to record an artifact whose digest is not the one the manifest promised", async () => {
    const { recordVerifiedArtifact, assertVerifiedArtifact } = await loadVerification()
    const artifact = writeArtifact("installer.exe", "something else entirely")

    await assert.rejects(recordVerifiedArtifact(artifact.path, new URL(CDN_URL), createHash("md5").update("what the manifest listed").digest("hex")), /did not match the official manifest/)

    await assert.rejects(assertVerifiedArtifact(artifact.path), /not downloaded and verified in this session/)
  })

  it("refuses an artifact this session never verified", async () => {
    const { assertVerifiedArtifact } = await loadVerification()
    const artifact = writeArtifact("installer.exe", "arrived from somewhere else")

    await assert.rejects(assertVerifiedArtifact(artifact.path), /not downloaded and verified in this session/)
  })

  it("keeps its records per path, not per session", async () => {
    const { recordVerifiedArtifact, assertVerifiedArtifact } = await loadVerification()
    const verified = writeArtifact("installer.exe", "the installer bytes")
    const other = writeArtifact("other-installer.exe", "the installer bytes")

    await recordVerifiedArtifact(verified.path, new URL(CDN_URL), verified.md5)

    await assert.rejects(assertVerifiedArtifact(other.path), /not downloaded and verified in this session/)
  })

  it("refuses an artifact that changed on disk after it was verified, and forgets it", async () => {
    const { recordVerifiedArtifact, assertVerifiedArtifact } = await loadVerification()
    const artifact = writeArtifact("installer.exe", "the installer bytes")
    await recordVerifiedArtifact(artifact.path, new URL(CDN_URL), artifact.md5)

    writeFileSync(artifact.path, "swapped between the download and the run")

    await assert.rejects(assertVerifiedArtifact(artifact.path), /no longer matches the verified artifact/)
    // The record is dropped, so a second attempt cannot be talked into a
    // re-check of a file that is already known to have changed.
    await assert.rejects(assertVerifiedArtifact(artifact.path), /not downloaded and verified in this session/)
  })

  it("refuses an artifact that disappeared after it was verified", async () => {
    const { recordVerifiedArtifact, assertVerifiedArtifact } = await loadVerification()
    const artifact = writeArtifact("installer.exe", "the installer bytes")
    await recordVerifiedArtifact(artifact.path, new URL(CDN_URL), artifact.md5)

    unlinkSync(artifact.path)

    await assert.rejects(assertVerifiedArtifact(artifact.path), /Installer path is unsafe/)
  })

  it("refuses an artifact replaced by a symbolic link after it was verified", async () => {
    const { recordVerifiedArtifact, assertVerifiedArtifact } = await loadVerification()
    const artifact = writeArtifact("installer.exe", "the installer bytes")
    await recordVerifiedArtifact(artifact.path, new URL(CDN_URL), artifact.md5)

    const elsewhere = writeArtifact("elsewhere.exe", "the installer bytes")
    unlinkSync(artifact.path)
    symlinkSync(elsewhere.path, artifact.path)

    // The contents would hash the same; the link itself is the refusal.
    await assert.rejects(assertVerifiedArtifact(artifact.path), /Installer path is unsafe/)
  })

  it("refuses a path that became a folder", async () => {
    const { recordVerifiedArtifact, assertVerifiedArtifact } = await loadVerification()
    const artifact = writeArtifact("installer.exe", "the installer bytes")
    await recordVerifiedArtifact(artifact.path, new URL(CDN_URL), artifact.md5)

    unlinkSync(artifact.path)
    mkdirSync(artifact.path)

    await assert.rejects(assertVerifiedArtifact(artifact.path))
  })
})

describe("getTrustedDownloadHash", () => {
  it("has no opinion about a host that is not the game CDN, and asks for nothing", async () => {
    const { getTrustedDownloadHash } = await loadVerification()

    assert.equal(await getTrustedDownloadHash(new URL("https://mods.vintagestory.at/download?fileid=1")), undefined)
    assert.equal(vi.mocked(requestBoundedText).mock.calls.length, 0)
  })

  it("returns the hash the manifest lists for the CDN URL", async () => {
    const hash = createHash("md5").update("the installer bytes").digest("hex")
    serveManifests({ "1.22.6": { windows: { urls: { cdn: CDN_URL, local: "https://account.vintagestory.at/files/vs_setup.exe" }, md5: hash.toUpperCase() } } })
    const { getTrustedDownloadHash } = await loadVerification()

    assert.equal(await getTrustedDownloadHash(new URL(CDN_URL)), hash)
  })

  it("matches the local URL a manifest entry lists as well as the CDN one", async () => {
    const hash = createHash("md5").update("the installer bytes").digest("hex")
    serveManifests({ "1.22.6": { windows: { urls: { cdn: "https://cdn.vintagestory.at/gamefiles/stable/other.exe", local: CDN_URL }, md5: hash } } })
    const { getTrustedDownloadHash } = await loadVerification()

    assert.equal(await getTrustedDownloadHash(new URL(CDN_URL)), hash)
  })

  it("finds an entry nested arbitrarily deep, and reads the unstable manifest too", async () => {
    const hash = createHash("md5").update("the installer bytes").digest("hex")
    serveManifests(
      { "1.22.6": { windows: { urls: { cdn: "https://cdn.vintagestory.at/gamefiles/stable/other.exe" }, md5: hash } } },
      { releases: { "1.23.0-pre.1": { windows: { urls: { cdn: CDN_URL }, md5: hash } } } }
    )
    const { getTrustedDownloadHash } = await loadVerification()

    assert.equal(await getTrustedDownloadHash(new URL(CDN_URL)), hash)
  })

  it("refuses a CDN URL the manifest does not list", async () => {
    serveManifests({ "1.22.6": { windows: { urls: { cdn: "https://cdn.vintagestory.at/gamefiles/stable/other.exe" }, md5: createHash("md5").update("other").digest("hex") } } })
    const { getTrustedDownloadHash } = await loadVerification()

    await assert.rejects(getTrustedDownloadHash(new URL(CDN_URL)), /not present in the official Vintage Story manifest/)
  })

  it("refuses an entry whose URL matches but whose hash is not a hash", async () => {
    serveManifests({ "1.22.6": { windows: { urls: { cdn: CDN_URL }, md5: "not-a-digest" } } })
    const { getTrustedDownloadHash } = await loadVerification()

    await assert.rejects(getTrustedDownloadHash(new URL(CDN_URL)), /not present in the official Vintage Story manifest/)
  })

  it("walks past manifest members that are not objects", async () => {
    const hash = createHash("md5").update("the installer bytes").digest("hex")
    serveManifests({ note: "a string", count: 3, list: [1, 2, 3], entries: null, "1.22.6": { windows: { urls: { cdn: CDN_URL }, md5: hash } } })
    const { getTrustedDownloadHash } = await loadVerification()

    assert.equal(await getTrustedDownloadHash(new URL(CDN_URL)), hash)
  })

  it("tolerates an entry whose urls member is not an object", async () => {
    const hash = createHash("md5").update("the installer bytes").digest("hex")
    serveManifests({ broken: { urls: "https://cdn.vintagestory.at/whatever", md5: hash }, "1.22.6": { windows: { urls: { cdn: CDN_URL }, md5: hash } } })
    const { getTrustedDownloadHash } = await loadVerification()

    assert.equal(await getTrustedDownloadHash(new URL(CDN_URL)), hash)
  })

  it("fetches the manifests once and answers the next lookup from memory", async () => {
    const hash = createHash("md5").update("the installer bytes").digest("hex")
    serveManifests({ "1.22.6": { windows: { urls: { cdn: CDN_URL }, md5: hash } } })
    const { getTrustedDownloadHash } = await loadVerification()

    await getTrustedDownloadHash(new URL(CDN_URL))
    await getTrustedDownloadHash(new URL(CDN_URL))

    // Two manifests, fetched once each, however many lookups follow.
    assert.equal(vi.mocked(requestBoundedText).mock.calls.length, 2)
  })

  it("drops the cache when a manifest cannot be fetched, so the next attempt tries again", async () => {
    const hash = createHash("md5").update("the installer bytes").digest("hex")
    vi.mocked(requestBoundedText).mockRejectedValueOnce(new Error("network is unreachable")).mockRejectedValueOnce(new Error("network is unreachable"))
    const { getTrustedDownloadHash } = await loadVerification()

    await assert.rejects(getTrustedDownloadHash(new URL(CDN_URL)), /network is unreachable/)

    serveManifests({ "1.22.6": { windows: { urls: { cdn: CDN_URL }, md5: hash } } })
    assert.equal(await getTrustedDownloadHash(new URL(CDN_URL)), hash)
  })

  it("drops the cache when a manifest is not JSON", async () => {
    vi.mocked(requestBoundedText).mockResolvedValue("<html>maintenance</html>")
    const { getTrustedDownloadHash } = await loadVerification()

    await assert.rejects(getTrustedDownloadHash(new URL(CDN_URL)))

    const hash = createHash("md5").update("the installer bytes").digest("hex")
    serveManifests({ "1.22.6": { windows: { urls: { cdn: CDN_URL }, md5: hash } } })
    assert.equal(await getTrustedDownloadHash(new URL(CDN_URL)), hash)
  })

  it("asks for both official manifests, under the shared response ceiling", async () => {
    serveManifests({}, {})
    const { getTrustedDownloadHash } = await loadVerification()

    await assert.rejects(getTrustedDownloadHash(new URL(CDN_URL)))

    const requested = vi.mocked(requestBoundedText).mock.calls.map((call) => call[0]?.toString())
    assert.deepEqual(requested.sort(), [STABLE_MANIFEST_URL, UNSTABLE_MANIFEST_URL])
    assert.equal((vi.mocked(requestBoundedText).mock.calls[0]?.[1] as { maxBytes?: number } | undefined)?.maxBytes, 4 * 1024 * 1024)
  })
})
