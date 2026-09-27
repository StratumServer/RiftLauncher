/**
 * Folding the patch CLI's stdout into one closed verdict.
 *
 * The CLI writes one compact JSON object per line: `progress` while it works,
 * `log` whenever it has something to say, and exactly one terminal `result`.
 * Everything a reader needs is in the first two fields of each object; the rest
 * is free text.
 *
 * This is the single boundary that keeps the CLI's prose out of the launcher.
 * `message` and `detail` carry absolute paths and whatever the engine felt like
 * writing, so they are parsed and dropped here rather than anywhere further in,
 * and no caller is ever handed a string it could log. What crosses is a token
 * out of a closed set and a number between 0 and 99.
 */

import { isRecord } from "../records"

/**
 * Why a run did not succeed.
 *
 * The first ten are the CLI's own wire tokens
 * (EngineProtocol.FailureReasonExtensions.Wire). The last four are the
 * launcher's, for the failures that happen where the CLI cannot speak:
 *
 * - `no-result`: the process ended without a terminal result line.
 * - `timed-out`: the run was still going at the wall-clock bound and was killed.
 * - `runtime-missing`: the .NET runtime the overlay needs is not installed, so
 *   nothing was ever run against the game folder.
 * - `output-unverified`: the CLI reported success and the files it claims to
 *   have written do not match what is on disk.
 */
export type OptimumFailureReason =
  | "bad-input"
  | "unsupported-version"
  | "patch-conflict"
  | "decompile-failed"
  | "assemble-failed"
  | "verification-failed"
  | "output-exists"
  | "source-unavailable"
  | "cancelled"
  | "engine-internal"
  | "no-result"
  | "timed-out"
  | "runtime-missing"
  | "output-unverified"

/** The ten tokens the CLI itself can send. Anything else on the wire is not one of its reasons. */
const WIRE_REASONS: readonly OptimumFailureReason[] = [
  "bad-input",
  "unsupported-version",
  "patch-conflict",
  "decompile-failed",
  "assemble-failed",
  "verification-failed",
  "output-exists",
  "source-unavailable",
  "cancelled",
  "engine-internal"
]

export type OptimumRunResult = { ok: true } | { ok: false; reason: OptimumFailureReason }

/** Longest line this reader will hold before giving up on it, so a process printing one endless line cannot grow the buffer without bound. */
const MAX_LINE_LENGTH = 64 * 1024

export interface OptimumOutputReader {
  /** Feeds one chunk of stdout, whole lines or not. */
  push(chunk: string): void
  /**
   * Closes the stream and reports the verdict.
   *
   * The first terminal result wins. The contract says there is exactly one, and
   * the runner cross-checks the process's exit code against this verdict
   * anyway, so a second one changes nothing a caller could act on.
   */
  finish(): OptimumRunResult
}

/**
 * Reads the reason off a failed result.
 *
 * A token outside the closed set reads as `engine-internal`: the run failed and
 * said so, the launcher simply cannot name why, which is the same position an
 * unexpected internal failure leaves it in. Echoing the unknown token would put
 * text from the child process into a log line.
 */
function readReason(value: unknown): OptimumFailureReason {
  return WIRE_REASONS.find((reason) => reason === value) ?? "engine-internal"
}

/**
 * Builds a reader over one run's stdout.
 *
 * @param onProgress Called with each forward tick, clamped to 0..99. Backwards
 * and repeated ticks are dropped: the caller owns the last one, and a bar that
 * goes backwards reads as a bug to the player.
 */
export function createOptimumOutputReader(onProgress?: (progress: number) => void): OptimumOutputReader {
  let buffer = ""
  let lastProgress = 0
  let result: OptimumRunResult | undefined

  function readLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }

    if (!isRecord(parsed)) return

    if (parsed.type === "progress") {
      const { progress } = parsed
      if (typeof progress !== "number" || !Number.isFinite(progress)) return
      const clamped = Math.min(99, Math.max(0, Math.trunc(progress)))
      if (clamped <= lastProgress) return
      lastProgress = clamped
      onProgress?.(clamped)
      return
    }

    if (parsed.type !== "result" || result !== undefined) return
    result = parsed.ok === true ? { ok: true } : { ok: false, reason: readReason(parsed.reason) }
  }

  return {
    push(chunk: string): void {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        readLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
      }
      // A line longer than any line this protocol produces is not a line worth
      // completing. Dropping the buffer loses that line and keeps the reader
      // able to pick the stream back up at the next newline.
      if (buffer.length > MAX_LINE_LENGTH) buffer = ""
    },
    finish(): OptimumRunResult {
      // A last line with no trailing newline is still a line. A partial one
      // fails its JSON parse and is dropped, which is what leaves the run
      // without a result.
      readLine(buffer)
      buffer = ""
      return result ?? { ok: false, reason: "no-result" }
    }
  }
}
