/**
 * Running Optimum's own CLI against a game folder.
 *
 * This is the largest thing the launcher has ever spawned: a binary it fetched
 * over the network. What bounds it is everything that happened before the call,
 * not anything here. The archive matched the hash the session manifest
 * published, every staged file matched its own hash, and both folder arguments
 * passed `assertManagedPath`. The contract establishes that the patch writes
 * nothing outside `--game-dir`, so those two checks cover the whole child
 * process.
 *
 * What is bounded here is the run itself: no shell, a fixed argument list, a
 * cut-down environment, a working directory inside the overlay, a wall clock
 * with a SIGKILL behind it, and stdout read through the NDJSON fold that drops
 * everything the child wrote but a reason token.
 *
 * Nothing in this file imports Electron, so the whole runner can be driven
 * against a fake CLI from a plain test.
 */

import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { join } from "node:path"

import { createOptimumOutputReader, type OptimumRunResult } from "@domain/optimum/ndjson"
import { cliFileName, patchArgs, rollbackArgs } from "@domain/optimum/plan"
import { attemptInstallerTreeKill } from "@src/ipc/handlers/installerTimeoutOutcome"

/**
 * Wall clock for one patch. Twenty minutes, because each of the four targets is
 * its own Optimum.Patcher process with a five-minute bound of its own, so the
 * CLI's own worst case is just under this.
 *
 * Node sends SIGTERM at the bound, which the CLI traps into a clean `cancelled`
 * run, and {@link SIGKILL_GRACE_MS} later the whole run is killed outright if it
 * is still there.
 */
const PATCH_TIMEOUT_MS = 20 * 60 * 1_000

/**
 * How long a timed-out run gets to exit on its own before it is killed.
 *
 * The shorter of half a minute and the run's own wall clock, so a patch is
 * never held open for more than twice what it was given, and a short bound in a
 * test does not wait thirty seconds for the kill it is checking.
 */
const SIGKILL_GRACE_MS = 30 * 1_000

/** The preflight is one process printing one line. Ten seconds is generous for that and short enough not to look like a hang. */
const VERSION_PROBE_TIMEOUT_MS = 10 * 1_000

/** Ceiling on what the CLI may print before the run is killed. The protocol is a few hundred short lines; a megabyte is far past any of them. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * The environment the child runs with, built rather than inherited.
 *
 * A .NET apphost needs somewhere to look for its runtime and somewhere to write
 * temporary files, and nothing else the launcher's own environment happens to
 * carry. Building the list rather than deleting from `process.env` means a
 * variable nobody thought about is absent by default instead of present by
 * default.
 */
const FORWARDED_ENVIRONMENT_KEYS = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SystemDrive", "TEMP", "TMP", "TMPDIR", "DOTNET_ROOT", "LANG"]

function childEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of FORWARDED_ENVIRONMENT_KEYS) {
    const value = process.env[key]
    if (typeof value === "string") environment[key] = value
  }
  // The CLI writes NDJSON and nothing else on stdout; .NET's own startup chatter
  // would be noise in the fold and a line the reader has to drop.
  environment["DOTNET_NOLOGO"] = "1"
  environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
  return environment
}

export interface OptimumRunOptions {
  /** Folder the verified overlay was staged into, which is also the child's working directory. */
  overlayDirectory: string
  /** The game folder the patch acts on. Absolute, or the CLI refuses the run as bad-input. */
  gameDirectory: string
  /** Whether this run patches or restores. */
  mode: "patch" | "rollback"
  /** File the child's stderr is streamed into. Never read back, never interpolated into a log line. */
  stderrLogPath?: string
  /** Forward progress ticks, 0 to 99. The last tick is the caller's to own. */
  onProgress?: (progress: number) => void
  /** Overridden only by tests, which cannot wait twenty minutes to see a timeout. */
  timeoutMs?: number
  /** Overridden only by tests, so a Windows CLI name can be exercised from Linux. */
  platform?: string
}

/**
 * Kills the whole run rather than the one process the launcher spawned.
 *
 * Each of the four targets is its own `Optimum.Patcher` process, so signalling
 * the CLI alone leaves grandchildren rewriting assemblies inside `--game-dir`
 * after the launcher has already told the player the patch was stopped. The run
 * is given a process group of its own (see `detached` below) so there is
 * something to signal; Windows has no such group, and RUN_INSTALLER's own
 * `taskkill /T /F` walk already covers that side.
 */
function killRunTree(child: ChildProcess, platform: string): void {
  if (platform === "win32") return attemptInstallerTreeKill(child.pid, "win32", spawn, () => undefined)

  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
  } catch {
    // The group is already gone, which is the outcome this was after anyway.
  }
}

/**
 * Turns an exit code and a folded stdout into one verdict.
 *
 * The contract: 0 with a terminal ok result is success, 2 is always `bad-input`,
 * and anything else takes the reason the run reported, falling back to
 * `no-result` when it reported none. A timeout wins over all of it, because the
 * SIGTERM behind it is trapped into `cancelled` and "the launcher stopped
 * waiting" is the more honest thing to say.
 */
export function readRunOutcome(exitCode: number | undefined, streamed: OptimumRunResult, timedOut: boolean): OptimumRunResult {
  if (timedOut) return { ok: false, reason: "timed-out" }
  if (exitCode === 0) return streamed.ok ? { ok: true } : streamed
  if (exitCode === 2) return { ok: false, reason: "bad-input" }
  if (exitCode === undefined) return { ok: false, reason: streamed.ok ? "engine-internal" : streamed.reason }
  return streamed.ok ? { ok: false, reason: "no-result" } : streamed
}

/**
 * Runs the CLI once and reports what it made of the folder.
 *
 * Never rejects: a spawn that never happened, a run that hung and a run that
 * failed all come back as a reason token.
 */
export function runOptimumCli(options: OptimumRunOptions): Promise<OptimumRunResult> {
  const { overlayDirectory, gameDirectory, mode, stderrLogPath, onProgress, timeoutMs = PATCH_TIMEOUT_MS, platform = process.platform } = options
  const cli = join(overlayDirectory, cliFileName(platform))
  const args = mode === "rollback" ? rollbackArgs(gameDirectory) : patchArgs(gameDirectory, overlayDirectory)

  return new Promise<OptimumRunResult>((resolvePromise) => {
    const reader = createOptimumOutputReader(onProgress)
    const stderrLog = stderrLogPath ? createWriteStream(stderrLogPath, { flags: "a" }) : undefined
    let timedOut = false
    let spawnFailed = false
    let printed = 0

    // `spawn` rather than `execFile`, which drops the one option this run needs:
    // `detached` gives the CLI a process group of its own, and without one the
    // kill below reaches the CLI and none of the patchers it started.
    const child = spawn(cli, args, {
      cwd: overlayDirectory,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      detached: platform !== "win32"
    })

    // Node's own `timeout` sends SIGTERM and then waits forever. This is the
    // second half of that: a run that trapped the signal and stopped answering
    // is killed rather than left holding the patch open.
    const killTimer = setTimeout(
      () => {
        timedOut = true
        killRunTree(child, platform)
      },
      timeoutMs + Math.min(SIGKILL_GRACE_MS, timeoutMs)
    )

    // A CLI that was never there fails to spawn and then closes like any other
    // run: nothing was said, so the fold answers for it.
    child.on("error", () => {
      spawnFailed = true
    })

    child.on("close", (code, signal) => {
      clearTimeout(killTimer)
      stderrLog?.end()
      if (signal === "SIGTERM" || signal === "SIGKILL") timedOut = true
      resolvePromise(readRunOutcome(spawnFailed || code === null ? undefined : code, reader.finish(), timedOut))
    })

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      printed += chunk.length
      // A run printing past the ceiling is not one the launcher keeps reading:
      // the protocol is a few hundred short lines, and the fold drops all of it
      // but a token either way.
      if (printed > MAX_OUTPUT_BYTES) return killRunTree(child, platform)
      reader.push(chunk)
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => stderrLog?.write(chunk))
    // A stderr log that cannot be written is not worth failing a patch over.
    stderrLog?.on("error", () => undefined)
  })
}

/**
 * Whether the runtime the overlay needs is installed, asked before anything
 * promises the player a patch.
 *
 * The overlay is framework-dependent `net10.0` with no bundled runtime, so a
 * machine without .NET 10 gets an apphost that prints an install hint and exits
 * non-zero. Finding that out from `--version`, which touches nothing, is the
 * difference between a refusal the player can act on and a half-patched folder.
 */
export async function isOptimumRuntimeAvailable(overlayDirectory: string, platform: string = process.platform): Promise<boolean> {
  const cli = join(overlayDirectory, cliFileName(platform))

  return new Promise<boolean>((resolve) => {
    execFile(cli, ["--version"], { cwd: overlayDirectory, env: childEnvironment(), shell: false, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, timeout: VERSION_PROBE_TIMEOUT_MS }, (error) =>
      resolve(error === null)
    )
  })
}
