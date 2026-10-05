import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
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
 *
 * The overlay built here is the linux-x64 one its manifest says it is, and its
 * CLI is a Node script. Windows can start neither: CreateProcess reads no
 * shebang, and NTFS carries no execute bit for the extraction to put back. The
 * cases that run the CLI or read that bit are Linux only for those two reasons,
 * and the refusals that happen before anything is spawned run everywhere. A
 * Windows player runs the real optimum.exe out of a win-x64 overlay, so what is
 * skipped here is the fixture, not the launcher.
 */

const needsTheFakeCli = it.skipIf(process.platform === "win32")

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
const written = mode === "short" || mode === "half" ? assemblies.slice(0, 1) : assemblies
fs.mkdirSync(path.join(gameDirectory, ".optimum", "vanilla", "Mods"), { recursive: true })
const records = []
for (const assembly of assemblies) {
  const full = path.join(gameDirectory, assembly)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  // The backup the real patch takes, with the suffix only the root assemblies carry.
  const backup = assembly.includes("/") ? path.join(gameDirectory, ".optimum", "vanilla", assembly) : path.join(gameDirectory, ".optimum", "vanilla", assembly.replace(".dll", ".vanilla.dll"))
  if (fs.existsSync(full)) fs.copyFileSync(full, backup)
  const contents = mode === "missing-ref" && assembly === "Mods/VSEssentials.dll" ? "patched " + assembly + "\\0Optimum.GameContent\\0" : "patched " + assembly
  if (written.includes(assembly)) fs.writeFileSync(full, contents)
  records.push({ assembly, vanillaHash: "sha256:" + "0".repeat(64), patchedHash: "sha256:" + crypto.createHash("sha256").update(contents).digest("hex") })
}
fs.writeFileSync(path.join(gameDirectory, "Optimum.Api.Contracts.dll"), "contracts")
// The assembly the patched VSEssentials.dll references, as Optimum's patcher deploys it: the
// file that was there first is backed up, or a marker says there was none, and only the first
// time, so a second run does not mistake its own copy for the build's.
const gameContent = path.join(gameDirectory, "Optimum.GameContent.dll")
const gameContentBackup = path.join(gameDirectory, ".optimum", "vanilla", "Optimum.GameContent.dll")
if (!fs.existsSync(gameContentBackup) && !fs.existsSync(gameContentBackup + ".absent")) {
  if (fs.existsSync(gameContent)) fs.copyFileSync(gameContent, gameContentBackup)
  else fs.writeFileSync(gameContentBackup + ".absent", "")
}
fs.writeFileSync(gameContent, "optimum game content")
fs.writeFileSync(path.join(gameDirectory, ".optimum", "version"), "0.3.14")
fs.writeFileSync(path.join(gameDirectory, ".optimum", "manifest.json"), JSON.stringify({ optimumVersion: "0.3.14", patchedAtUtc: "2026-09-14T00:00:00Z", gameDirectory, targets: records }))

// The run that stops partway: the backups are taken, one assembly is replaced
// and the rest are not, which is the folder a killed or conflicted patch leaves.
if (mode === "half") {
  line({ type: "result", ok: false, reason: "patch-conflict", message: gameDirectory })
  process.exit(1)
}

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

/**
 * A patched build written by hand, so a restore can be driven without a CLI: the
 * vanilla copy of each assembly the patch replaces, the patched one in its place,
 * and the contracts assembly at the root. What the patch did about
 * `Optimum.GameContent.dll` is left to each case.
 *
 * @returns the folder the backups are in.
 */
function patchedBuild(): string {
  const vanilla = join(gameDirectory, ".optimum", "vanilla")
  mkdirSync(join(vanilla, "Mods"), { recursive: true })
  for (const [live, backup] of [
    ["VintagestoryLib.dll", "VintagestoryLib.vanilla.dll"],
    ["VintagestoryAPI.dll", "VintagestoryAPI.vanilla.dll"],
    [join("Mods", "VSEssentials.dll"), join("Mods", "VSEssentials.dll")]
  ] as const) {
    copyFileSync(join(gameDirectory, live), join(vanilla, backup))
    writeFileSync(join(gameDirectory, live), `patched ${live}`)
  }
  writeFileSync(join(gameDirectory, "Optimum.Api.Contracts.dll"), "contracts")
  return vanilla
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
  needsTheFakeCli("stages the archive, runs the patch, and accepts what it wrote", async () => {
    const progress: number[] = []
    const manifest = buildOverlay()

    const result = await applyOptimumOverlay({ manifest, archivePath, overlayDirectory, gameDirectory, gameVersion: "1.22.7", platform: "linux", onProgress: (value) => progress.push(value) })

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(progress, [40, 99])
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "patched VintagestoryLib.dll")
    assert.equal(existsSync(join(gameDirectory, ".optimum", "vanilla", "VintagestoryLib.vanilla.dll")), true)
  })

  needsTheFakeCli("puts the execute bit back on the CLI the extraction published", async () => {
    await apply(buildOverlay())

    assert.equal(statSync(join(overlayDirectory, "optimum")).mode & 0o111, 0o111)
  })

  needsTheFakeCli("converges on a second run instead of compounding", async () => {
    const manifest = buildOverlay()

    assert.deepEqual(await apply(manifest), { ok: true })
    assert.deepEqual(await apply(manifest), { ok: true })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "patched VintagestoryLib.dll")
  })

  needsTheFakeCli("re-stages an overlay something has tampered with since", async () => {
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

  it("refuses an archive whose hash is not the published one, even at the published size", async () => {
    // The archive on disk is intact; what does not match is the hash the manifest
    // vouches for it with, which is the only thing standing between a swapped
    // payload and a child process.
    const manifest = buildOverlay()
    manifest.archive.sha256 = sha256(Buffer.from("a different archive entirely"))

    assert.deepEqual(await apply(manifest), { ok: false, reason: "overlay-unverified" })
    assert.equal(existsSync(overlayDirectory), false)
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

  needsTheFakeCli("carries a failed patch's own reason through", async () => {
    assert.deepEqual(await apply(buildOverlay({ cliMode: "fail:patch-conflict" })), { ok: false, reason: "patch-conflict" })
  })

  needsTheFakeCli("refuses the half patch that still exits 0, and puts the build back", async () => {
    assert.deepEqual(await apply(buildOverlay({ cliMode: "short" })), { ok: false, reason: "output-unverified", rolledBack: true })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
  })

  needsTheFakeCli("rolls back when patched assemblies reference a missing Optimum assembly", async () => {
    assert.deepEqual(await apply(buildOverlay({ cliMode: "missing-ref" })), { ok: false, reason: "output-unverified", rolledBack: true })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
  })

  needsTheFakeCli("puts the assemblies back when the run stops partway, rather than leaving two overlays in one folder", async () => {
    // What a killed patch leaves: one assembly replaced, three not, and a state
    // file recording an overlay version that matches neither. Saying the build
    // was left as it was is only true if it was put back.
    const result = await apply(buildOverlay({ cliMode: "half" }))

    assert.deepEqual(result, { ok: false, reason: "patch-conflict", rolledBack: true })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
    assert.equal(readFileSync(join(gameDirectory, "Mods", "VSEssentials.dll"), "utf8"), "vanilla essentials")
    assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
    assert.equal(existsSync(join(gameDirectory, "Optimum.Api.Contracts.dll")), false)
  })

  needsTheFakeCli("takes the game content assembly back out when the run is refused after deploying it", async () => {
    // The overlay deploys Optimum.GameContent.dll before the launcher's own check can
    // still refuse the run, and the marker its rollback would read sits in the state
    // folder this rollback removes, so whether the file stays is decided here.
    const result = await apply(buildOverlay({ cliMode: "short" }))

    assert.deepEqual(result, { ok: false, reason: "output-unverified", rolledBack: true })
    assert.equal(existsSync(join(gameDirectory, "Optimum.GameContent.dll")), false)
    assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
  })

  needsTheFakeCli("keeps the plain refusal when the run failed before it wrote anything", async () => {
    // Nothing was replaced and nothing was backed up, so there is nothing to put
    // back and nothing to claim about it.
    assert.deepEqual(await apply(buildOverlay({ cliMode: "fail:source-unavailable" })), { ok: false, reason: "source-unavailable" })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
  })
})

describe("restoreVanillaBuild", () => {
  needsTheFakeCli("puts the assemblies back and takes Optimum's own marks off", async () => {
    await apply(buildOverlay())
    writeFileSync(join(gameDirectory, "Optimum.GameContent.dll"), "game content")
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "patched VintagestoryLib.dll")
    assert.equal(existsSync(join(gameDirectory, "Optimum.GameContent.dll")), true)

    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: true })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryAPI.dll"), "utf8"), "vanilla api")
    assert.equal(readFileSync(join(gameDirectory, "Mods", "VSEssentials.dll"), "utf8"), "vanilla essentials")
    assert.equal(existsSync(join(gameDirectory, "Optimum.Api.Contracts.dll")), false)
    assert.equal(existsSync(join(gameDirectory, "Optimum.GameContent.dll")), false)
    assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
  })

  it("refuses a folder with no backup to restore from, and changes nothing", async () => {
    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: false, reason: "backup-missing" })
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
  })

  needsTheFakeCli("refuses a backup missing one of the two root assemblies", async () => {
    await apply(buildOverlay())
    rmSync(join(gameDirectory, ".optimum", "vanilla", "VintagestoryLib.vanilla.dll"))

    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: false, reason: "backup-missing" })
  })

  needsTheFakeCli("can be asked twice, and says so the second time rather than pretending", async () => {
    await apply(buildOverlay())

    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: true })
    assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: false, reason: "backup-missing" })
  })

  describe("the game content assembly", () => {
    it("removes it when the patch put it in a build that had none", async () => {
      const vanilla = patchedBuild()
      writeFileSync(join(gameDirectory, "Optimum.GameContent.dll"), "optimum game content")
      // What the patch writes in place of a backup when there was no file to back up.
      writeFileSync(join(vanilla, "Optimum.GameContent.dll.absent"), "")

      assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: true })
      assert.equal(existsSync(join(gameDirectory, "Optimum.GameContent.dll")), false)
      assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
      assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
    })

    it("puts the build's own copy back when the patch backed one up", async () => {
      const vanilla = patchedBuild()
      writeFileSync(join(gameDirectory, "Optimum.GameContent.dll"), "optimum game content")
      writeFileSync(join(vanilla, "Optimum.GameContent.dll"), "the copy the build had")

      assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: true })
      assert.equal(readFileSync(join(gameDirectory, "Optimum.GameContent.dll"), "utf8"), "the copy the build had")
      assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
    })

    it("restores a build patched by an overlay that never shipped it as before", async () => {
      patchedBuild()

      assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: true })
      assert.equal(existsSync(join(gameDirectory, "Optimum.GameContent.dll")), false)
      assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "vanilla lib")
      assert.equal(readFileSync(join(gameDirectory, "VintagestoryAPI.dll"), "utf8"), "vanilla api")
      assert.equal(readFileSync(join(gameDirectory, "Mods", "VSEssentials.dll"), "utf8"), "vanilla essentials")
      assert.equal(existsSync(join(gameDirectory, "Optimum.Api.Contracts.dll")), false)
      assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
    })

    it("removes one that nothing recorded either way, as it does the contracts", async () => {
      patchedBuild()
      writeFileSync(join(gameDirectory, "Optimum.GameContent.dll"), "optimum game content")

      assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: true })
      assert.equal(existsSync(join(gameDirectory, "Optimum.GameContent.dll")), false)
      assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
    })

    it("is left where it is by the refusal that restores nothing", async () => {
      const vanilla = patchedBuild()
      writeFileSync(join(gameDirectory, "Optimum.GameContent.dll"), "optimum game content")
      writeFileSync(join(vanilla, "Optimum.GameContent.dll.absent"), "")
      rmSync(join(vanilla, "VintagestoryLib.vanilla.dll"))

      assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: false, reason: "backup-missing" })
      assert.equal(readFileSync(join(gameDirectory, "Optimum.GameContent.dll"), "utf8"), "optimum game content")
      assert.equal(existsSync(join(vanilla, "Optimum.GameContent.dll.absent")), true)
    })

    it("keeps the state folder when it cannot be put back, so the backups are still there to try again", async () => {
      const vanilla = patchedBuild()
      writeFileSync(join(gameDirectory, "Optimum.GameContent.dll"), "optimum game content")
      // A folder where the backup should be is a copy that cannot be made, on every platform.
      mkdirSync(join(vanilla, "Optimum.GameContent.dll"))

      assert.deepEqual(await restoreVanillaBuild(gameDirectory), { ok: false, reason: "restore-failed" })
      assert.equal(existsSync(join(vanilla, "VintagestoryLib.vanilla.dll")), true)
    })
  })
})
