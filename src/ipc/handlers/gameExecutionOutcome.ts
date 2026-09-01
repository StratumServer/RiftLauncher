/**
 * Maps EXECUTE_GAME's internal outcomes onto the {@link GameExecutionResult}
 * wire type.
 *
 * Pulled out of gameHandlers.ts because that file calls `ipcMain.handle` at
 * module load, which needs a running Electron main process and so cannot be
 * imported by a unit test (the gap tracked in issue #27). Nothing in this
 * file touches Electron or Node, so a test can import it directly and pin
 * which reason each refusal gets without standing up the app.
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
  return outcome.started ? { ok: true, exitCode: outcome.exitCode } : { ok: false, reason: "launch-failed" }
}
