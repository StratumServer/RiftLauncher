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

import semver from "semver"

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
 * the probe ran but printed no version anywhere in its output, which is what
 * an executable that does not understand `-v` looks like, and what a fork that
 * answers it with something else entirely looks like too.
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
 * Shape of a version token anywhere in a line of output: three dotted numbers
 * with an optional dot-separated pre-release tail, which is how both the game
 * catalog and ModDB publish versions (`1.21.1`, `1.21.0-rc.1`).
 *
 * This only finds candidates. `semver.valid` makes the call on each one, so
 * what detection accepts is exactly what compareGameVersionsDesc can order on
 * the other side, rather than a second grammar that drifts from it.
 */
const VERSION_TOKEN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/g

/**
 * Reads a version out of probe output.
 *
 * A vanilla binary answers `-v` with a bare version and nothing else, so this
 * used to be a `.trim()`. Forks are not so quiet: Optimum prints a shader
 * compatibility line during startup, and storing that whole line is what put
 * "[Optimum] Shader compatibility scan: sources=48..." in a player's VS Version
 * field. So the whole output is scanned, not just its first line, and the first
 * token that parses wins. Several distinct versions in one output is not a
 * situation anything can resolve honestly, and first-wins at least matches what
 * a person reading the output top to bottom would pick.
 */
function extractVersion(stdout: string): string | undefined {
  for (const [token] of stdout.matchAll(VERSION_TOKEN)) if (semver.valid(token)) return token
  return undefined
}

/**
 * Turns a probe outcome into a verdict.
 *
 * Output with no version in it at all reads as `unreadable-version`, the same
 * verdict an empty stdout gets, which LOOK_FOR_A_GAME_VERSION reports as "not
 * found" and the form answers by leaving the field empty for the player to type
 * into. An exotic build the grammar cannot read is a version nobody detected,
 * not a version equal to whatever it happened to print.
 */
function interpretProbe(outcome: ProcessProbeOutcome): DetectInstalledGameVersionResult {
  if (!outcome.ok) return { ok: false, reason: "probe-failed" }

  const version = extractVersion(outcome.stdout)
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
