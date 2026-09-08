/**
 * Maps EXECUTE_GAME's internal outcomes onto the {@link GameExecutionResult}
 * wire type.
 *
 * Pulled out of gameHandlers.ts because that file calls `ipcMain.handle` at
 * module load, which needs a running Electron main process and so cannot be
 * imported by a unit test (the gap tracked in issue #27). Nothing in this
 * file touches Electron or Node, so a test can import it directly and pin
 * which reason each refusal gets without standing up the app.
 *
 * The stderr sentinel scan below lives here for the same reason: it is a pure
 * string test, and the code that feeds it in gameHandlers.ts is not reachable
 * from a test on its own.
 */

import type { GameProcessOutcome } from "@domain/ports"
import type { BuildGameLaunchPlanFailure } from "@domain/versions/launch"

/** Carries {@link BuildGameLaunchPlanFailure} straight onto the wire: the two vocabularies are the same on purpose. */
export function launchPlanFailureResult(reason: BuildGameLaunchPlanFailure): GameExecutionResult {
  return { ok: false, reason }
}

/** The version folder could not even be listed, which leaves no candidate executable to find. */
export function noExecutableResult(): GameExecutionResult {
  return { ok: false, reason: "no-executable" }
}

/**
 * The executable failed its last check before spawning (not a real file, or a symlink), or a
 * configured launch wrapper could not be resolved to an executable.
 */
export function invalidExecutableResult(): GameExecutionResult {
  return { ok: false, reason: "launch-failed" }
}

/** The account session could not be written into the installation's clientsettings.json. */
export function sessionWriteFailedResult(): GameExecutionResult {
  return { ok: false, reason: "session-write-failed" }
}

/** The installation's own start environment variables could not be parsed. */
export function invalidRequestResult(): GameExecutionResult {
  return { ok: false, reason: "invalid-request" }
}

/**
 * Maps the terminal {@link GameProcessOutcome} onto the wire.
 *
 * `started: true` becomes the exit, at whatever exit code it exited with.
 * `started: false` means the spawn itself never happened, which now resolves
 * `launch-failed` instead of rejecting: rejecting with a bare boolean was the
 * anti-pattern that left the renderer unable to clear `_playing` on this path.
 */
export function gameProcessOutcomeToResult(outcome: GameProcessOutcome): GameExecutionResult {
  if (!outcome.started) return { ok: false, reason: "launch-failed" }
  return outcome.missingRuntime ? { ok: false, reason: "missing-dotnet" } : { ok: true, exitCode: outcome.exitCode }
}

/**
 * The fixed line the .NET host prints to stderr when no installed runtime
 * satisfies the framework a build asks for. It is the host's own wording, not
 * the game's, so it is the same on every distro and for every game version.
 */
const MISSING_DOTNET_SENTINEL = "You must install or update .NET to run this application."

/**
 * How much of stderr is kept for the sentinel scan.
 *
 * The host prints the sentence as its first line, so a few kilobytes is far
 * more than enough, and the bound is what keeps a chatty game from growing a
 * string for the length of a play session. A sentence straddling the cut-off
 * would be missed, which only a game that printed 4 KiB before failing to
 * start could arrange.
 */
const STDERR_SCAN_LIMIT = 4_096

/** Appends a stderr chunk to the scanned head, stopping at {@link STDERR_SCAN_LIMIT}. */
export function appendStderrScan(head: string, chunk: string): string {
  return head.length >= STDERR_SCAN_LIMIT ? head : head + chunk.slice(0, STDERR_SCAN_LIMIT - head.length)
}

/**
 * Whether the scanned stderr contains the .NET host's missing-runtime
 * sentinel. Accumulating first is what makes this survive the sentence
 * arriving split across two `data` events.
 */
export function hasMissingDotnetSentinel(head: string): boolean {
  return head.includes(MISSING_DOTNET_SENTINEL)
}
