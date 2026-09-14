import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest"

import "./helpers/electronMock"
import { setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { hostRid } from "@domain/optimum/plan"

/**
 * src/ipc/optimumManifest.ts, the session's copy of Optimum's overlay manifest.
 *
 * The transport is the one thing mocked. `runDownload` has its own file
 * (tests/ipc/download.test.ts) for the redirect chain, the byte ceiling and the
 * digest; what matters here is what the launcher does with what comes back: it
 * parses the document off disk, refuses one that is not for this machine,
 * remembers the good one for the session, and forgets a failure so the next ask
 * tries again.
 */
vi.mock("@src/ipc/workers/download", () => ({ runDownload: vi.fn() }))

/** The platform the running machine would look for. Undefined on a host Optimum publishes nothing for. */
const RID = hostRid(process.platform, process.arch)
const OTHER_RID = RID === "win-x64" ? "linux-x64" : "win-x64"
const ARCHIVE_HASH = "c".repeat(64)

let temporaryRoot: string

function manifestDocument(overrides: Record<string, unknown> = {}): string {
  const rid = (overrides.rid as string | undefined) ?? RID ?? "linux-x64"
  const optimumVersion = (overrides.optimumVersion as string | undefined) ?? "0.3.14"

  return JSON.stringify({
    manifestVersion: 1,
    optimumVersion,
    supportedGameVersions: ["1.22.7"],
    rid,
    archive: { filename: `Optimum-v${optimumVersion}-${rid}-overlay.tar.gz`, size: 1_024, sha256: `sha256:${ARCHIVE_HASH}` },
    targets: [],
    files: [{ path: "optimum", size: 10, sha256: `sha256:${"d".repeat(64)}` }],
    ...overrides
  })
}

/**
 * Loads a fresh copy of the module under test with a transport that answers
 * `answer` once per call, so each test gets its own empty session cache.
 */
async function load(answer: (call: number) => string | Error): Promise<typeof import("@src/ipc/optimumManifest") & { calls: () => number }> {
  vi.resetModules()
  const { runDownload } = await import("@src/ipc/workers/download")
  let call = 0

  vi.mocked(runDownload).mockImplementation(async (options) => {
    const outcome = answer(call++)
    if (outcome instanceof Error) throw outcome
    mkdirSync(options.outputPath, { recursive: true })
    const path = join(options.outputPath, String(options.fileName))
    writeFileSync(path, outcome)
    return path
  })

  const module = await import("@src/ipc/optimumManifest")
  return Object.assign(module, { calls: (): number => call })
}

beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "optimum-manifest-"))
  mkdirSync(join(temporaryRoot, "userData"), { recursive: true })
  setElectronUserDataPath(join(temporaryRoot, "userData"))
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))
})

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("getOptimumManifest", () => {
  it.skipIf(RID === undefined)("reads the published manifest and hands the renderer only what it decides with", async () => {
    const { getOptimumManifest } = await load(() => manifestDocument())

    const result = await getOptimumManifest()

    assert.ok(result.ok)
    assert.equal(result.manifest.optimumVersion, "0.3.14")
    assert.deepEqual(result.manifest.supportedGameVersions, ["1.22.7"])
    assert.equal(result.manifest.archiveFileName, `Optimum-v0.3.14-${RID}-overlay.tar.gz`)
    assert.equal(result.manifest.downloadUrl, `https://github.com/StratumServer/Optimum/releases/download/v0.3.14/Optimum-v0.3.14-${RID}-overlay.tar.gz`)
    // The hash, the file list and the donors stay on this side of the bridge.
    assert.deepEqual(Object.keys(result.manifest).sort(), ["archiveFileName", "downloadFolder", "downloadUrl", "optimumVersion", "supportedGameVersions"])
  })

  it.skipIf(RID === undefined)("writes the manifest into the launcher's own cache and parses it back off disk", async () => {
    const { getOptimumManifest, optimumCacheDirectory } = await load(() => manifestDocument())

    await getOptimumManifest()

    assert.equal(JSON.parse(readFileSync(join(optimumCacheDirectory(), "optimum-manifest.json"), "utf8")).optimumVersion, "0.3.14")
  })

  it.skipIf(RID === undefined)("fetches once per session and answers every later ask from what it read", async () => {
    const module = await load(() => manifestDocument())

    const first = await module.getOptimumManifest()
    const second = await module.getOptimumManifest()

    assert.ok(first.ok)
    assert.ok(second.ok)
    assert.equal(module.calls(), 1)
  })

  it("reports an unreachable manifest without saying more than it knows", async () => {
    const module = await load(() => new Error("Download failed"))

    assert.deepEqual(await module.getOptimumManifest(), { ok: false, reason: "unreachable" })
  })

  it("forgets a failure so the next ask tries again", async () => {
    const module = await load((call) => (call === 0 ? new Error("Download failed") : manifestDocument()))

    const first = await module.getOptimumManifest()
    const second = await module.getOptimumManifest()

    assert.equal(first.ok, false)
    assert.equal(module.calls(), 2)
    assert.equal(second.ok, RID !== undefined)
  })

  for (const [label, document] of [
    ["a document that is not a manifest", "not json"],
    ["a manifest version this build does not know", JSON.stringify({ manifestVersion: 2 })],
    [
      "a manifest whose archive name does not match its version",
      JSON.stringify({
        manifestVersion: 1,
        optimumVersion: "0.3.14",
        supportedGameVersions: ["1.22.7"],
        rid: "linux-x64",
        archive: { filename: "payload.tar.gz", size: 1, sha256: `sha256:${"a".repeat(64)}` },
        files: []
      })
    ]
  ] as const) {
    it(`refuses ${label}`, async () => {
      const module = await load(() => document)

      assert.deepEqual(await module.getOptimumManifest(), { ok: false, reason: "unreadable" })
    })
  }

  it("offers nothing when the published overlay is for another platform", async () => {
    const module = await load(() => manifestDocument({ rid: OTHER_RID }))

    assert.deepEqual(await module.getOptimumManifest(), { ok: false, reason: "unsupported-system" })
  })
})

describe("getTrustedOverlayHash", () => {
  it.skipIf(RID === undefined)("answers with the hash the session manifest published for that exact address", async () => {
    const module = await load(() => manifestDocument())
    const result = await module.getOptimumManifest()
    assert.ok(result.ok)

    assert.equal(await module.getTrustedOverlayHash(new URL(result.manifest.downloadUrl)), ARCHIVE_HASH)
  })

  it("leaves every other download alone", async () => {
    const module = await load(() => manifestDocument())

    assert.equal(await module.getTrustedOverlayHash(new URL("https://cdn.vintagestory.at/gamefiles/stable/vs_client_linux-x64_1.22.7.tar.gz")), undefined)
    assert.equal(await module.getTrustedOverlayHash(new URL("https://mods.vintagestory.at/download?fileid=1")), undefined)
  })

  it("refuses an Optimum asset the session manifest does not vouch for", async () => {
    const module = await load(() => manifestDocument())
    await module.getOptimumManifest()

    await assert.rejects(
      module.getTrustedOverlayHash(new URL("https://github.com/StratumServer/Optimum/releases/download/v9.9.9/Optimum-v9.9.9-linux-x64-overlay.tar.gz")),
      /Unverified Optimum download/
    )
  })

  it("refuses an Optimum asset when no manifest was ever read", async () => {
    const module = await load(() => new Error("Download failed"))

    await assert.rejects(
      module.getTrustedOverlayHash(new URL("https://github.com/StratumServer/Optimum/releases/download/v0.3.14/Optimum-v0.3.14-linux-x64-overlay.tar.gz")),
      /Unverified Optimum download/
    )
  })
})
