import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import type { OptimumManifest } from "@domain/optimum/manifest"
import { cliFileName } from "@domain/optimum/plan"
import { verifyPatchedOutput, verifyStagedOverlay } from "@src/ipc/optimumOverlay"
import { isOptimumRuntimeAvailable, readRunOutcome, runOptimumCli } from "@src/ipc/optimumPatch"

/**
 * The patch runner, driven end to end against a CLI that is a Node script.
 *
 * Nothing here is mocked: a real process is spawned, its real stdout is folded
 * through the real NDJSON reader, its real exit code is mapped, and the real
 * verification passes read the real files it wrote. The script prints the shape
 * Optimum's own `NdjsonWriter` prints, and takes an environment variable for
 * how the run should end, which is how a `patch-conflict`, an exit 2, a hang
 * and a half-written folder are all exercised without any of them being
 * simulated at the module boundary.
 *
 * It is a stand-in for the payload, not for the protocol: no overlay archive
 * has ever been published, so the contract these assertions encode was read out
 * of Optimum's source rather than observed against a real one.
 *
 * On Windows none of that happens. The runner spawns the name the plan builds
 * with no shell, so CreateProcess is asked to start `optimum.exe`, and a Node
 * script is not something it can start: there are no shebangs, a shim cannot
 * carry that name and be a batch file, and Node refuses to spawn a batch file
 * without a shell anyway. The cases that need a child process are Linux only for
 * that reason, and the cases that need none, which are the outcome mapping and
 * the staging checks, run everywhere. A Windows player runs the real optimum.exe
 * out of the overlay, so what is skipped here is the fixture, not the launcher.
 */

const needsTheFakeCli = it.skipIf(process.platform === "win32")

const TARGETS = [
  { assembly: "VintagestoryLib.dll", donor: ".optimum/donors/VintagestoryLib.Donor.dll", mode: "transplant" },
  { assembly: "Mods/VSEssentials.dll", donor: ".optimum/donors/VSEssentials.Donor.dll", mode: "mod", modName: "vsessentials" }
]

/**
 * A CLI that behaves like the real one, told how to end through a file beside it.
 *
 * A file rather than an environment variable, because the runner builds the
 * child's environment from a fixed list instead of inheriting one, so nothing a
 * test exported would ever reach it. It also writes down whether a variable the
 * launcher's own process carries made it across, which is how the "built, not
 * inherited" promise is checked rather than asserted.
 *
 * Deliberately a Node script rather than a shell script: the launcher spawns
 * with `shell: false`, so anything needing a shell would not run at all, which
 * is itself worth the file not hiding.
 */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

let mode = "ok"
try {
  mode = fs.readFileSync(path.join(__dirname, "mode"), "utf8").trim()
} catch {}

const args = process.argv.slice(2)
const gameDirectory = args[args.indexOf("--game-dir") + 1]
fs.writeFileSync(path.join(__dirname, "seen.json"), JSON.stringify({ args, secret: process.env.OPTIMUM_TEST_SECRET || null, cwd: process.cwd() }))

function line(value) {
  process.stdout.write(JSON.stringify(value) + "\\n")
}

if (args[0] === "--version") {
  process.stdout.write("0.3.14\\n")
  process.exit(mode === "no-runtime" ? 150 : 0)
}

if (mode === "hang" || mode === "grandchild") {
  // The patcher the real CLI spawns per target: its own process, still writing
  // into --game-dir long after the CLI stopped answering.
  if (mode === "grandchild") {
    require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'written after the kill'), 1200)", path.join(gameDirectory, "grandchild-wrote-this.txt")], { stdio: "ignore" })
  }
  process.on("SIGTERM", () => {})
  setInterval(() => {}, 1000)
  return
}

line({ type: "log", level: "info", message: "Patching " + gameDirectory })
for (const progress of [10, 40, 90]) line({ type: "progress", phase: "patch", progress, detail: gameDirectory })

if (mode === "no-result") process.exit(1)
if (mode === "usage") process.exit(2)
if (mode.startsWith("fail:")) {
  line({ type: "result", ok: false, reason: mode.slice(5), message: gameDirectory })
  process.exit(1)
}

// The happy path, and the "one file short" variant that still exits 0 the way a
// failed mod donor does.
const written = mode === "short" ? TARGET_LIST.slice(0, 1) : TARGET_LIST
fs.mkdirSync(path.join(gameDirectory, ".optimum", "vanilla"), { recursive: true })
const records = []
for (const assembly of TARGET_LIST) {
  const full = path.join(gameDirectory, assembly)
  const contents = "patched " + assembly
  fs.mkdirSync(path.dirname(full), { recursive: true })
  if (written.includes(assembly)) fs.writeFileSync(full, contents)
  // Recorded either way, which is the point of the short mode: a failed mod
  // donor only warns, so the run still exits 0 claiming an assembly it never wrote.
  records.push({ assembly, vanillaHash: "sha256:" + "0".repeat(64), patchedHash: "sha256:" + crypto.createHash("sha256").update(contents).digest("hex") })
}
fs.writeFileSync(path.join(gameDirectory, ".optimum", "manifest.json"), JSON.stringify({ optimumVersion: "0.3.14", patchedAtUtc: "2026-09-14T00:00:00Z", gameDirectory, targets: records }))

line({ type: "progress", phase: "verify", progress: 99, detail: gameDirectory })
line({ type: "result", ok: true, runtimePath: gameDirectory })
process.exit(0)
`.replaceAll("TARGET_LIST", JSON.stringify(TARGETS.map((target) => target.assembly)))

let workspace: string
let overlayDirectory: string
let gameDirectory: string

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function manifest(overrides: Partial<OptimumManifest> = {}): OptimumManifest {
  return {
    manifestVersion: 1,
    optimumVersion: "0.3.14",
    supportedGameVersions: ["1.22.7"],
    rid: "linux-x64",
    archive: { filename: "Optimum-v0.3.14-linux-x64-overlay.tar.gz", size: 10, sha256: sha256("archive") },
    targets: TARGETS,
    files: [],
    ...overrides
  }
}

/** Writes the fake CLI into the overlay folder under the name the runner will look for, and makes it runnable. */
function installFakeCli(): void {
  const cli = join(overlayDirectory, cliFileName(process.platform))
  writeFileSync(cli, FAKE_CLI)
  chmodSync(cli, 0o755)
}

/** Tells the fake CLI how this run should end. */
function setMode(mode: string): void {
  writeFileSync(join(overlayDirectory, "mode"), mode)
}

/** What the fake CLI was handed: its argument list, its working directory, and whether an exported variable reached it. */
function seen(): { args: string[]; secret: string | null; cwd: string } {
  return JSON.parse(readFileSync(join(overlayDirectory, "seen.json"), "utf8"))
}

/** Stages one file in the overlay and returns the manifest entry that vouches for it. */
function stage(path: string, contents: string): { path: string; size: number; sha256: string } {
  const full = join(overlayDirectory, ...path.split("/"))
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, contents)
  return { path, size: Buffer.byteLength(contents), sha256: sha256(contents) }
}

function run(mode: string, options: { timeoutMs?: number } = {}): ReturnType<typeof runOptimumCli> {
  setMode(mode)
  return runOptimumCli({ overlayDirectory, gameDirectory, mode: "patch", ...options })
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "optimum-patch-"))
  overlayDirectory = join(workspace, "overlay")
  gameDirectory = join(workspace, "game")
  mkdirSync(overlayDirectory, { recursive: true })
  mkdirSync(gameDirectory, { recursive: true })
  installFakeCli()
})

afterEach(() => {
  delete process.env.OPTIMUM_TEST_SECRET
  rmSync(workspace, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("runOptimumCli", () => {
  it("runs a clean patch and forwards its progress", async () => {
    const progress: number[] = []
    setMode("ok")

    const result = await runOptimumCli({ overlayDirectory, gameDirectory, mode: "patch", onProgress: (value) => progress.push(value) })

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(progress, [10, 40, 90, 99])
    assert.equal(readFileSync(join(gameDirectory, "VintagestoryLib.dll"), "utf8"), "patched VintagestoryLib.dll")
  })

  it("passes the game folder and the overlay folder, both absolute, asks for JSON, and never asks for a run without a backup", async () => {
    await run("ok")

    assert.deepEqual(seen().args, ["patch", "--game-dir", gameDirectory, "--overlay", overlayDirectory, "--json"])
    assert.equal(seen().cwd, overlayDirectory)
  })

  it("asks for the rollback with the game folder alone", async () => {
    setMode("ok")
    await runOptimumCli({ overlayDirectory, gameDirectory, mode: "rollback" })

    assert.deepEqual(seen().args, ["patch", "--game-dir", gameDirectory, "--rollback", "--json"])
  })

  it("builds the child's environment rather than handing it the launcher's", async () => {
    process.env.OPTIMUM_TEST_SECRET = "a value the child must never see"

    await run("ok")

    assert.equal(seen().secret, null)
  })

  it("reads exit 2 as bad input even when the run said nothing terminal", async () => {
    assert.deepEqual(await run("usage"), { ok: false, reason: "bad-input" })
  })

  for (const reason of ["patch-conflict", "verification-failed", "cancelled", "engine-internal", "source-unavailable"] as const) {
    it(`carries a failed run's own ${reason} through`, async () => {
      assert.deepEqual(await run(`fail:${reason}`), { ok: false, reason })
    })
  }

  it("reads a reason the CLI never published as engine-internal", async () => {
    assert.deepEqual(await run("fail:something-new"), { ok: false, reason: "engine-internal" })
  })

  it("reports no-result when a failed run printed nothing terminal", async () => {
    assert.deepEqual(await run("no-result"), { ok: false, reason: "no-result" })
  })

  it("kills a run that ignores the signal and reports the timeout as its own reason", async () => {
    const result = await run("hang", { timeoutMs: 300 })

    assert.deepEqual(result, { ok: false, reason: "timed-out" })
  })

  it("kills the patcher processes the run spawned, not just the CLI", async () => {
    // The CLI is one process and the patch is five: a SIGKILL aimed at the pid
    // the launcher holds leaves the rest rewriting assemblies inside the game
    // folder while the player is being told the patch was stopped.
    const marker = join(gameDirectory, "grandchild-wrote-this.txt")

    const result = await run("grandchild", { timeoutMs: 300 })

    assert.deepEqual(result, { ok: false, reason: "timed-out" })
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    assert.equal(existsSync(marker), false)
  })

  it("reports a refusal, not a success, when there is no CLI to spawn", async () => {
    rmSync(join(overlayDirectory, cliFileName(process.platform)))

    // `no-result` is the honest token here: nothing ran, so nothing was said.
    // A player never reaches it, because the preflight below refuses a missing
    // or unrunnable CLI as `runtime-missing` before a patch is ever promised.
    assert.deepEqual(await run("ok"), { ok: false, reason: "no-result" })
  })

  it("streams stderr to a file and never into the verdict", async () => {
    const stderrLogPath = join(workspace, "optimum-patch-task.txt")
    setMode("ok")

    const result = await runOptimumCli({ overlayDirectory, gameDirectory, mode: "patch", stderrLogPath })

    assert.deepEqual(Object.keys(result), ["ok"])
    assert.equal(readFileSync(stderrLogPath, "utf8"), "")
  })
})

describe("readRunOutcome", () => {
  it("lets a timeout win over whatever the run managed to say", () => {
    assert.deepEqual(readRunOutcome(0, { ok: true }, true), { ok: false, reason: "timed-out" })
    assert.deepEqual(readRunOutcome(1, { ok: false, reason: "cancelled" }, true), { ok: false, reason: "timed-out" })
  })

  it("refuses a zero exit whose run reported a failure", () => {
    assert.deepEqual(readRunOutcome(0, { ok: false, reason: "patch-conflict" }, false), { ok: false, reason: "patch-conflict" })
  })

  it("refuses a non-zero exit whose run claimed success", () => {
    assert.deepEqual(readRunOutcome(1, { ok: true }, false), { ok: false, reason: "no-result" })
  })

  it("lets exit 2 mean bad input whatever the run reported", () => {
    // The contract reserves 2 for that one reason, so a run that exits 2 while
    // naming something else is a run the launcher believes the code of.
    assert.deepEqual(readRunOutcome(2, { ok: false, reason: "patch-conflict" }, false), { ok: false, reason: "bad-input" })
    assert.deepEqual(readRunOutcome(2, { ok: true }, false), { ok: false, reason: "bad-input" })
    assert.deepEqual(readRunOutcome(2, { ok: false, reason: "no-result" }, false), { ok: false, reason: "bad-input" })
  })
})

describe("isOptimumRuntimeAvailable", () => {
  needsTheFakeCli("answers yes when the CLI can print its own version", async () => {
    assert.equal(await isOptimumRuntimeAvailable(overlayDirectory), true)
  })

  needsTheFakeCli("answers no when the apphost refuses for want of a runtime", async () => {
    setMode("no-runtime")

    assert.equal(await isOptimumRuntimeAvailable(overlayDirectory), false)
  })

  it("answers no when there is no CLI to ask", async () => {
    rmSync(join(overlayDirectory, cliFileName(process.platform)))

    assert.equal(await isOptimumRuntimeAvailable(overlayDirectory), false)
  })
})

describe("verifyStagedOverlay", () => {
  // These build the whole staging folder out of `stage`, so the fixture the other
  // blocks need would be one more file the manifest never named.
  beforeEach(() => {
    rmSync(overlayDirectory, { recursive: true, force: true })
    mkdirSync(overlayDirectory, { recursive: true })
  })

  it("accepts a staging folder that matches the manifest file for file", async () => {
    const files = [stage("optimum", "the cli"), stage(".optimum/donors/VintagestoryLib.Donor.dll", "a donor")]
    writeFileSync(join(overlayDirectory, "optimum-manifest.json"), "{}")

    assert.equal(await verifyStagedOverlay(overlayDirectory, manifest({ files })), true)
  })

  it("refuses a file whose bytes are not the ones the manifest hashed", async () => {
    const files = [stage("optimum", "the cli")]
    writeFileSync(join(overlayDirectory, "optimum"), "a swapped cli")

    assert.equal(await verifyStagedOverlay(overlayDirectory, manifest({ files })), false)
  })

  it("refuses a file whose size is not the one the manifest recorded", async () => {
    const files = [stage("optimum", "the cli")]
    assert.equal(await verifyStagedOverlay(overlayDirectory, manifest({ files: files.map((file) => ({ ...file, size: file.size + 1 })) })), false)
  })

  it("refuses a manifest entry with nothing on disk behind it", async () => {
    const files = [stage("optimum", "the cli"), { path: "patcher/Optimum.Patcher.dll", size: 4, sha256: sha256("gone") }]

    assert.equal(await verifyStagedOverlay(overlayDirectory, manifest({ files })), false)
  })

  it("refuses a staged file the manifest never named", async () => {
    const files = [stage("optimum", "the cli")]
    stage("payload.sh", "#!/bin/sh\nrm -rf /\n")

    assert.equal(await verifyStagedOverlay(overlayDirectory, manifest({ files })), false)
  })

  it("refuses a staged symbolic link even where the manifest names that path", async () => {
    const files = [stage("optimum", "the cli")]
    rmSync(join(overlayDirectory, "optimum"))
    await import("node:fs").then(({ symlinkSync }) => symlinkSync("/bin/sh", join(overlayDirectory, "optimum")))

    assert.equal(await verifyStagedOverlay(overlayDirectory, manifest({ files })), false)
  })
})

describe("verifyPatchedOutput", () => {
  needsTheFakeCli("accepts a folder whose recorded hashes match what is on disk", async () => {
    await run("ok")

    assert.equal(await verifyPatchedOutput(gameDirectory, manifest()), true)
  })

  needsTheFakeCli("refuses the half patch a failed mod donor leaves behind, which still exits 0", async () => {
    const result = await run("short")

    assert.deepEqual(result, { ok: true })
    assert.equal(await verifyPatchedOutput(gameDirectory, manifest()), false)
  })

  needsTheFakeCli("refuses a folder whose assemblies were rewritten after the patch", async () => {
    await run("ok")
    writeFileSync(join(gameDirectory, "VintagestoryLib.dll"), "something else entirely")

    assert.equal(await verifyPatchedOutput(gameDirectory, manifest()), false)
  })

  it("refuses a folder the patch never wrote anything into", async () => {
    assert.equal(await verifyPatchedOutput(gameDirectory, manifest()), false)
  })

  needsTheFakeCli("refuses a record written by a different overlay version", async () => {
    await run("ok")

    assert.equal(await verifyPatchedOutput(gameDirectory, manifest({ optimumVersion: "0.4.0" })), false)
  })

  needsTheFakeCli("refuses a manifest that names no target, since it vouches for nothing", async () => {
    await run("ok")

    assert.equal(await verifyPatchedOutput(gameDirectory, manifest({ targets: [] })), false)
  })
})
