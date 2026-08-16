/**
 * Decides whether a folder holds an installed Vintage Story and, if so, what
 * version it is.
 *
 * This is the decision LOOK_FOR_A_GAME_VERSION has always made when a user
 * points the "add an existing install" dialog at a folder: pick the
 * executable {@link gameExecutableCandidates} expects for the host platform,
 * run it with `-v`, and read the version back off stdout. Reusing that table
 * keeps this in lockstep with EXECUTE_GAME and install.ts's own verification,
 * so the three can never independently drift on what a Vintage Story folder
 * looks like.
 *
 * The one thing this module does not do is run anything: {@link ProcessProbe}
 * is a port precisely so the domain never imports `child_process`, and the
 * actual spawn (with whatever timeout the host wants to bound it by) stays on
 * the main process side, same as every other side effect in this codebase.
 */

import type { PathBuilder, ProcessProbe, ProcessProbeOutcome, ProcessProbeRequest } from "../ports"
import { gameExecutableCandidates, toGameOs } from "./gameExecutable"
import type { GameExecutableCandidate, GameOs } from "./gameExecutable"

/**
 * Why a folder was not read as an installed version.
 *
 * `no-executable` means none of {@link gameExecutableCandidates} was found,
 * which on macOS is every folder, since the launcher has no expectation to
 * check there yet. `probe-failed` covers a probe the host could not run to
 * completion, including one it had to time out. `unreadable-version` means
 * the probe ran but printed nothing usable, which is what an executable that
 * does not understand `-v` looks like.
 */
export type DetectInstalledGameVersionFailure = "no-executable" | "probe-failed" | "unreadable-version"

export type DetectInstalledGameVersionResult = { ok: true; version: string } | { ok: false; reason: DetectInstalledGameVersionFailure }

export interface DetectInstalledGameVersionPorts {
  paths: PathBuilder
  processProbe: ProcessProbe
}

export interface DetectInstalledGameVersionInput {
  /** Host platform, as the host spells it. Narrowed with {@link toGameOs}. */
  platform: string
  /** Folder the user pointed the dialog at. */
  folder: string
  /** Names directly inside that folder, as listed by the host. */
  fileNames: readonly string[]
}

/** The first candidate the folder actually contains, in the order the OS prefers them. */
function pickExecutable(os: GameOs, fileNames: readonly string[]): GameExecutableCandidate | undefined {
  return gameExecutableCandidates(os).find((candidate) => fileNames.includes(candidate.fileName))
}

/**
 * Builds the command a candidate is probed with.
 *
 * A direct candidate is run as itself. A mono candidate is run through
 * `mono`, with the executable's own path moved into the argument list, the
 * same substitution EXECUTE_GAME makes for the same file.
 */
function probeRequestFor(candidate: GameExecutableCandidate, executablePath: string): ProcessProbeRequest {
  return candidate.launchMode === "mono" ? { command: "mono", args: [executablePath, "-v"] } : { command: executablePath, args: ["-v"] }
}

/**
 * Turns a probe outcome into a verdict.
 *
 * The version is whatever the process printed to stdout, trimmed. That is
 * exactly what LOOK_FOR_A_GAME_VERSION has always taken it to be: Vintage
 * Story's `-v` flag prints the version and nothing else, so there is no
 * further format to parse out of it.
 */
function interpretProbe(outcome: ProcessProbeOutcome): DetectInstalledGameVersionResult {
  if (!outcome.ok) return { ok: false, reason: "probe-failed" }

  const version = outcome.stdout.trim()
  if (!version) return { ok: false, reason: "unreadable-version" }

  return { ok: true, version }
}

/**
 * Looks for an installed Vintage Story in `input.folder` and reads its
 * version.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The folder to check, its contents, and the host platform.
 * @returns The version found, or the reason none was.
 */
export async function detectInstalledGameVersion(ports: DetectInstalledGameVersionPorts, input: DetectInstalledGameVersionInput): Promise<DetectInstalledGameVersionResult> {
  const os = toGameOs(input.platform)
  const candidate = pickExecutable(os, input.fileNames)
  if (!candidate) return { ok: false, reason: "no-executable" }

  const executablePath = await ports.paths.join([input.folder, candidate.fileName])
  const outcome = await ports.processProbe.run(probeRequestFor(candidate, executablePath))

  return interpretProbe(outcome)
}
