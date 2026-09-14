import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"
import * as tar from "tar"

import type { OptimumManifest } from "@domain/optimum/manifest"
import { applyOptimumOverlay, restoreVanillaBuild } from "@src/ipc/optimumInstall"

/**
 * src/ipc/optimumInstall.ts, driven against a real archive and a real child
 * process.
 *
 * The overlay is built here, tarred here, hashed here and unpacked by the
 * launcher's own extraction, so "the staged overlay matches the manifest" means
 * the same thing it will mean in production. The CLI inside it is a Node script
 * that prints the contract's NDJSON and writes the folder the patch would
 * write; how a run ends is baked into the archive, which is also how the
 * verification of that file is exercised rather than worked around.
 */

const TARGETS = [
  { assembly: "VintagestoryLib.dll", donor: ".optimum/donors/VintagestoryLib.Donor.dll", mode: "transplant" },
  { assembly: "VintagestoryAPI.dll", donor: ".optimum/donors/VintagestoryAPI.Contracts.dll", mode: "api" },
  { assembly: "Mods/VSEssentials.dll", donor: ".optimum/donors/VSEssentials.Donor.dll", mode: "mod", modName: "vsessentials" }
]

const ASSEMBLIES = JSON.stringify(TARGETS.map((target) => target.assembly))

/** A CLI that behaves like Optimum's, with its ending compiled in. */
function fakeCli(mode: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const mode = ${JSON.stringify(mode)}
const args = process.argv.slice(2)
const gameDirectory = args[args.indexOf("--game-dir") + 1]
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n")

if (args[0] === "--version") {
  if (mode === "no-runtime") {
    process.stderr.write("You must install .NET to run this application.\\n")
    process.exit(150)
  }
  process.stdout.write("0.3.14\\n")
  process.exit(0)
}

line({ type: "progress", phase: "patch", progress: 40, detail: gameDirectory })

if (mode.startsWith("fail:")) {
  line({ type: "result", ok: false, reason: mode.slice(5), message: gameDirectory })
  process.exit(1)
}

const assemblies = ${ASSEMBLIES}
const written = mode === "short" ? assemblies.slice(0, 1) : assemblies
fs.mkdirSync(path.join(gameDirectory, ".optimum", "vanilla", "Mods"), { recursive: true })
const records = []
for (const assembly of assemblies) {
  const full = path.join(gameDirectory, assembly)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  // The backup the real patch takes, with the suffix only the root assemblies carry.
  const backup = assembly.includes("/") ? path.join(gameDirectory, ".optimum", "vanilla", assembly) : path.join(gameDirectory, ".optimum", "vanilla", assembly.replace(".dll", ".vanilla.dll"))
  if (fs.existsSync(full)) fs.copyFileSync(full, backup)
  const contents = "patched " + assembly
  if (written.includes(assembly)) fs.writeFileSync(full, contents)
  records.push({ assembly, vanillaHash: "sha256:" + "0".repeat(64), patchedHash: "sha256:" + crypto.createHash("sha256").update(contents).digest("hex") })
}
fs.writeFileSync(path.join(gameDirectory, "Optimum.Api.Contracts.dll"), "contracts")
fs.writeFileSync(path.join(gameDirectory, ".optimum", "version"), "0.3.14")
fs.writeFileSync(path.join(gameDirectory, ".optimum", "manifest.json"), JSON.stringify({ optimumVersion: "0.3.14", patchedAtUtc: "2026-09-14T00:00:00Z", gameDirectory, targets: records }))

line({ type: "progress", phase: "verify", progress: 99, detail: gameDirectory })
line({ type: "result", ok: true, runtimePath: gameDirectory })
process.exit(0)
`
}

const ARCHIVE_NAME = "Optimum-v0.3.14-linux-x64-overlay.tar.gz"
const ROOT_FOLDER = "Optimum-v0.3.14-linux-x64-overlay"

let workspace: string
let cacheRoot: string
let overlayDirectory: string
let gameDirectory: string
let archivePath: string

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Builds the overlay archive and the manifest that vouches for it.
 *
 * `extraFiles` lands inside the archive without reaching the manifest, which is
 * how "a file the manifest never named" is exercised against a real tarball.
 */
function buildOverlay(options: { cliMode?: string; extraFiles?: Record<string, string>; dropFromManifest?: string[] } = {}): OptimumManifest {
  const { cliMode = "ok", extraFiles = {}, dropFromManifest = [] } = options
  const stagingRoot = join(workspace, "staging")
  rmSync(stagingRoot, { recursive: true, force: true })

  const contents: Record<string, string> = {
    optimum: fakeCli(cliMode),
    ".optimum/donors/VintagestoryLib.Donor.dll": "a donor assembly",
    "assets/game/shaders/chunkopaque.fsh": "a shader",
    ...extraFiles
  }

  for (const [path, text] of Object.entries(contents)) {
    const full = join(stagingRoot, ROOT_FOLDER, ...path.split("/"))
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, text)
  }
  chmodSync(join(stagingRoot, ROOT_FOLDER, "optimum"), 0o755)
  // The one file the packaging walk cannot list, because it is written after it.
  writeFileSync(join(stagingRoot, ROOT_FOLDER, "optimum-manifest.json"), "{}")

  tar.create({ sync: true, gzip: true, cwd: stagingRoot, file: archivePath }, [ROOT_FOLDER])
  const archive = readFileSync(archivePath)

  const files = Object.entries(contents)
    .filter(([path]) => !dropFromManifest.includes(path) && !Object.keys(extraFiles).includes(path))
    .map(([path, text]) => ({ path, size: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) }))

  return {
    manifestVersion: 1,
    optimumVersion: "0.3.14",
    supportedGameVersions: ["1.22.7"],
    rid: "linux-x64",
    archive: { filename: ARCHIVE_NAME, size: archive.length, sha256: sha256(archive) },
    targets: TARGETS,
    files
  }
}

function apply(manifest: OptimumManifest, gameVersion = "1.22.7"): Promise<OptimumPatchResult> {
  return applyOptimumOverlay({ manifest, archivePath, overlayDirectory, gameDirectory, gameVersion, platform: "linux" })
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "optimum-install-"))
  cacheRoot = join(workspace, "cache")
  overlayDirectory = join(cacheRoot, "0.3.14-linux-x64")
  gameDirectory = join(workspace, "versions", "1.22.7")
  archivePath = join(cacheRoot, ARCHIVE_NAME)
  mkdirSync(cacheRoot, { recursive: true })
  mkdirSync(join(gameDirectory, "Mods"), { recursive: true })
  writeFileSync(join(gameDirectory, "VintagestoryLib.dll"), "vanilla lib")
  writeFileSync(join(gameDirectory, "VintagestoryAPI.dll"), "vanilla api")
  writeFileSync(join(gameDirectory, "Mods", "VSEssentials.dll"), "vanilla essentials")
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("applyOptimumOverlay", () => {
  it("stages the archive, runs the patch, and accepts what it wrote", async () => {
    const progress: number[] = []
    const manifest = buildOverlay()

    const result = await applyOptimumOverlay({ manifest, archivePath, overlayDirectory, gameDirectory, gameVersion: "1.22.7", platform: "linux", onProgress: (value) => progress.push(value) })

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(progress, [40, 99])
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "patched VintagestoryLib.dll")
    assert.equal(existsSync(join(gameDirectory, ".optimum", "vanilla", "VintagestoryLib.vanilla.dll")), true)
  })

  it("puts the execute bit back on the CLI the extraction published", async () => {
    await apply(buildOverlay())

    assert.equal(statSync(join(overlayDirectory, "optimum")).mode & 0o111, 0o111)
  })

  it("converges on a second run instead of compounding", async () => {
    const manifest = buildOverlay()

    assert.deepEqual(await apply(manifest), { ok: true })
    assert.deepEqual(await apply(manifest), { ok: true })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "patched VintagestoryLib.dll")
  })

  it("re-stages an overlay something has tampered with since", async () => {
    const manifest = buildOverlay()
    await apply(manifest)
    writeFileSync(join(overlayDirectory, "optimum"), "#!/usr/bin/env node\nprocess.exit(0)\n")

    assert.deepEqual(await apply(manifest), { ok: true })
    assert.equal(readFileSync(join(overlayDirectory, "optimum"), "utf8").includes("runtimePath"), true)
  })

  it("refuses a build the overlay was never published for, before anything runs", async () => {
    const manifest = buildOverlay()

    assert.deepEqual(await apply(manifest, "1.22.6"), { ok: false, reason: "unsupported-version" })
    assert.equal(existsSync(overlayDirectory), false)
  })

  it("refuses an archive whose bytes are not the ones the manifest hashed", async () => {
    const manifest = buildOverlay()
    writeFileSync(archivePath, Buffer.concat([readFileSync(archivePath), Buffer.from("tampered")]))

    assert.deepEqual(await apply(manifest), { ok: false, reason: "overlay-unverified" })
    assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
  })

  it("refuses an archive that is not there at all", async () => {
    const manifest = buildOverlay()
    rmSync(archivePath)

    assert.deepEqual(await apply(manifest), { ok: false, reason: "overlay-unverified" })
  })

  it("refuses an archive carrying a file the manifest never named, and leaves nothing staged", async () => {
    const manifest = buildOverlay({ extraFiles: { "payload.sh": "#!/bin/sh\necho hi\n" } })

    assert.deepEqual(await apply(manifest), { ok: false, reason: "overlay-unverified" })
    assert.equal(existsSync(overlayDirectory), false)
  })

  it("refuses a manifest entry with nothing in the archive behind it", async () => {
    const manifest = buildOverlay()
    manifest.files.push({ path: "patcher/Optimum.Patcher.dll", size: 4, sha256: sha256(Buffer.from("gone")) })

    assert.deepEqual(await apply(manifest), { ok: false, reason: "overlay-unverified" })
  })

  it("refuses a staged file whose hash is not the published one", async () => {
    const manifest = buildOverlay()
    const donor = manifest.files.find((file) => file.path.endsWith("VintagestoryLib.Donor.dll"))
    assert.ok(donor)
    donor.sha256 = sha256(Buffer.from("a donor from somewhere else"))

    assert.deepEqual(await apply(manifest), { ok: false, reason: "overlay-unverified" })
  })

  it("refuses to promise a patch on a machine with no runtime to run it", async () => {
    const manifest = buildOverlay({ cliMode: "no-runtime" })

    assert.deepEqual(await apply(manifest), { ok: false, reason: "runtime-missing" })
    assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
  })

  it("carries a failed patch's own reason through", async () => {
    assert.deepEqual(await apply(buildOverlay({ cliMode: "fail:patch-conflict" })), { ok: false, reason: "patch-conflict" })
  })

  it("refuses the half patch that still exits 0", async () => {
    assert.deepEqual(await apply(buildOverlay({ cliMode: "short" })), { ok: false, reason: "output-unverified" })
  })
})

describe("restoreVanillaBuild", () => {
  it("puts the assemblies back and takes Optimum's own marks off", async () => {
    await apply(buildOverlay())
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "patched VintagestoryLib.dll")

    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: true })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryAPI.dll"), "utf8"), "vanilla api")
    assert.equal(readFileSync(join(gameDirectory, "Mods", "VSEssentials.dll"), "utf8"), "vanilla essentials")
    assert.equal(existsSync(join(gameDirectory, "Optimum.Api.Contracts.dll")), false)
    assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
  })

  it("refuses a folder with no backup to restore from, and changes nothing", async () => {
    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: false, reason: "backup-missing" })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
  })

  it("refuses a backup missing one of the two root assemblies", async () => {
    await apply(buildOverlay())
    rmSync(join(gameDirectory, ".optimum", "vanilla", "VintagestoryLib.vanilla.dll"))

    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: false, reason: "backup-missing" })
  })

  it("can be asked twice, and says so the second time rather than pretending", async () => {
    await apply(buildOverlay())

    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: true })
    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: false, reason: "backup-missing" })
  })
})
