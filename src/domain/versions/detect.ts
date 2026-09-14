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

/**
 * A fork of Vintage Story that names itself in the version probe's output.
 *
 * One variant is known, Optimum, which is why `name` is a literal rather than
 * a free string: the launcher chose the token, the probe never gets to pick it.
 * `version` is the fork's own version line (0.3.14 today), never the game's.
 */
export interface GameBuildVariant {
  name: "Optimum"
  version: string
}

export type DetectInstalledGameVersionResult = { ok: true; version: string; variant?: GameBuildVariant } | { ok: false; reason: DetectInstalledGameVersionFailure }

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
 *
 * The `(?<![\d.])` guard keeps a long run of digits from being rescanned once
 * per character: without it, `\d+` matches the run, fails on the missing dot
 * and backtracks the whole way, for every starting offset. Probe stdout has no
 * size cap, so a binary printing a megabyte of digits would hold the main
 * process for minutes.
 *
 * The `(?!\.?\d)` guard closes the other end. A token has to stop where the
 * number stops, or `127.0.0.1` reads as `127.0.0` and `1.21.1.2` as `1.21.1`,
 * both of which semver accepts and neither of which is a version anyone
 * printed. The rule it spells: the character after the token may not be a
 * digit, and may not be a dot with a digit behind it. That is the line between
 * punctuation and continuation, since `1.21.0-rc.1.` ending a sentence has a
 * dot followed by space or end, while `1.21.1.2` has a dot followed by a
 * segment. It sits after the pre-release group so it judges the end of the
 * whole token, which leaves pre-releases like `1.21.0-rc.1` untouched: the
 * group is greedy, so anything it could still swallow it already has.
 */
const VERSION_TOKEN = /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?!\.?\d)/g

/** The fork marker, built off {@link VERSION_TOKEN} so the two can never drift apart. */
const OPTIMUM_MARKER_SOURCE = `Optimum v(${VERSION_TOKEN.source})`
const OPTIMUM_MARKER = new RegExp(OPTIMUM_MARKER_SOURCE)

/** Every occurrence of it, for taking the fork's own number out of the game version's reach. */
const OPTIMUM_MARKERS = new RegExp(OPTIMUM_MARKER_SOURCE, "g")

/**
 * Reads a version out of probe output.
 *
 * The rule: the first line that is nothing but a version wins, and only when no
 * line is one does the whole output get scanned for the first version inside a
 * line.
 *
 * A vanilla binary answers `-v` with a bare version and nothing else, so this
 * used to be a `.trim()`. Forks are not so quiet, and their chatter is what the
 * two halves of the rule separate. Optimum prints "[Optimum] Optimum v0.3.14"
 * on the patch path, which is exactly the path a freshly installed folder takes
 * when someone points "Look for a Version" at it, and its shader owner lines
 * carry mod archive stems like "betterruins_1.9.2-4f0ab21c73"; both parse, and
 * both come before the 1.21.1 the client prints last, so taking the first token
 * anywhere reads the wrapper instead of the game. A fork logs about a version,
 * the game prints one, and the line that holds nothing else is the one that was
 * printed as an answer. The scan stays as the fallback for a build that prints
 * its version inside a sentence, where the first token is still the best guess
 * available.
 *
 * The marker text is cut out before either pass runs, which is what keeps the
 * fallback honest. The bare-line rule alone is not enough: Optimum's patch
 * chatter is printed before the client answers, so on any output with no bare
 * version line in it, the first token anywhere is the fork's own number, and
 * the fallback would hand back 0.3.14 as the game version. That happens on a
 * warm cache, where the patch path is skipped and only the long version line
 * "1.22.7 + Optimum v0.3.14" carries a number, and on a build that prints the
 * marker and nothing readable at all, which has to stay unreadable rather than
 * report the fork's version. A variant is never a substitute for the number
 * the compatibility checks run on.
 */
function extractVersion(stdout: string): string | undefined {
  const printed = stdout.replace(OPTIMUM_MARKERS, "")

  for (const line of printed.split("\n")) {
    const bare = semver.valid(line.trim())
    if (bare) return bare
  }

  for (const [token] of printed.matchAll(VERSION_TOKEN)) if (semver.valid(token)) return token
  return undefined
}

/**
 * Reads Optimum's own version out of probe output, when the build is one.
 *
 * Optimum's IL patch appends " + Optimum v<version>" to
 * `GameVersion.LongGameVersion`, and its patch path also logs
 * "[Optimum] Optimum v<version>". Both spell the marker the same way, so one
 * literal covers them, and the literal is what keeps this linear: anchoring on
 * "Optimum v" means the version grammar is only ever tried at the handful of
 * offsets that text appears at, rather than scanned for across unbounded stdout
 * and matched backwards to a name.
 *
 * The capture goes through the same `semver.valid` gate {@link extractVersion}
 * uses, off the same grammar, so a marker version detection accepts is one
 * compareGameVersionsDesc could order. A marker with something else after the
 * "v" reads as no marker at all.
 *
 * The folder's file names are deliberately not consulted. Optimum's packaging
 * script copies a vanilla-named binary next to the branded one, so a file named
 * `Optimum` is a side effect of packaging, and a file name is something anyone
 * can produce. The suffix comes from the patched DLL that actually changes how
 * the build behaves. One signal, the authoritative one.
 */
function extractOptimumVersion(stdout: string): string | undefined {
  const marker = OPTIMUM_MARKER.exec(stdout)
  return marker ? (semver.valid(marker[1] ?? "") ?? undefined) : undefined
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

  const variantVersion = extractOptimumVersion(outcome.stdout)
  return variantVersion ? { ok: true, version, variant: { name: "Optimum", version: variantVersion } } : { ok: true, version }
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
