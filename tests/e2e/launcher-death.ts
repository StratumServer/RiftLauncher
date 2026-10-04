/**
 * What the packaged Windows conformance run keeps of a launcher that dies on it
 * (issue #614). It lives beside packaged-windows-install.ts rather than in it
 * because that script exits on import anywhere but a Windows CI runner, which
 * leaves a test nothing to reach, and none of this needs Windows.
 */

import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type LauncherExit = { code: number | null; signal: NodeJS.Signals | null }

/**
 * The part of a ChildProcess these functions use. Node sets exitCode or
 * signalCode when the process ends and keeps them for good, so the exit is read
 * back from there, in whatever phase the run is in, rather than kept by a
 * listener of the script's own.
 */
export type LauncherProcess = Pick<ChildProcess, "exitCode" | "signalCode"> & NodeJS.EventEmitter

/** null while the launcher runs: a process that has ended always has an exit code or a signal, and 0 is a code. */
export function readLauncherExit(child: LauncherProcess): LauncherExit | null {
  return child.exitCode === null && child.signalCode === null ? null : { code: child.exitCode, signal: child.signalCode }
}

/**
 * The end of a sentence about the launcher process. A native crash on Windows
 * comes back as an NTSTATUS in the exit code (3221225477 is 0xC0000005, an access
 * violation), so a code above 255 is shown in hex beside its decimal form.
 */
export function describeLauncherExit({ code, signal }: LauncherExit): string {
  if (signal !== null) return `was ended by signal ${signal}`
  const hex = code !== null && code > 255 ? ` (0x${code.toString(16).toUpperCase()})` : ""
  return `exited with code ${code}${hex}`
}

/**
 * Why the DevTools socket closed, as far as the launcher process can say.
 *
 * When the launcher dies, its socket closing and its exit event reach this
 * script a moment apart and in either order, so a process that has not exited
 * yet gets `graceMs` to follow before it is called still running. Never rejects.
 */
export async function explainSocketClose(child: LauncherProcess, graceMs: number): Promise<string> {
  if (readLauncherExit(child) === null) await once(child, "exit", { signal: AbortSignal.timeout(graceMs) }).catch(() => undefined)
  const exit = readLauncherExit(child)
  return exit ? `the launcher process ${describeLauncherExit(exit)}` : `the launcher process was still running ${graceMs}ms later`
}

/**
 * The last `maxLines` lines of every `*.log` file in the launcher's Logs folder, by file name.
 *
 * It runs from the script's finally block, so it never throws: a missing folder gives no tails, and
 * a file it cannot read (or an empty one) is left out without hiding the others.
 */
export function readLogTails(userDataPath: string, maxLines: number): Record<string, string[]> {
  const logsPath = join(userDataPath, "Logs")
  const tails: Record<string, string[]> = {}

  let names: string[]
  try {
    names = readdirSync(logsPath)
  } catch {
    return tails
  }

  for (const name of names.filter((entry) => entry.endsWith(".log"))) {
    try {
      const lines = readFileSync(join(logsPath, name), "utf8")
        .split(/\r?\n/)
        .filter((line) => line !== "")
      if (lines.length > 0) tails[name] = lines.slice(-maxLines)
    } catch {
      // A folder named like a log, or a file another process still holds: the other logs still count.
    }
  }
  return tails
}
