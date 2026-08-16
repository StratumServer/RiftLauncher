/**
 * Pure helpers for RUN_INSTALLER: its bounded wait, and its verdict mapping.
 *
 * pathsHandlers.ts calls ipcMain.handle at module load, which needs a
 * running Electron main process and so cannot be imported directly by a unit
 * test (the same gap tracked in issue #27 for gameHandlers.ts). Neither the
 * timeout/kill decision nor the mapping onto {@link InstallerRunResult}
 * touches Electron or a live child_process, so both are pulled out here
 * where a test can pin them without standing up the app (mirrors
 * gameExecutionOutcome.ts, written for the same reason).
 */

/**
 * Builds the Windows command that kills an installer's whole process tree.
 *
 * A bare `ChildProcess#kill()` only signals the installer's own pid. The
 * silent Inno installer for 1.18.15 spawns a bundled .NET 7 Desktop Runtime
 * sub-installer (`dotnet70desktop_x64`) as a *child* process; killing just
 * the parent leaves that sub-installer running as an orphan (proven by the
 * windows-conformance run for issue #55, which had to be cleaned up by the
 * runner itself after the job died at its 30-minute ceiling). `/T` walks the
 * tree, `/F` forces the kill.
 */
export function buildInstallerTreeKillCommand(pid: number): { command: string; args: string[] } {
  return { command: "taskkill", args: ["/pid", String(pid), "/T", "/F"] }
}

/**
 * Whether an expired RUN_INSTALLER wait should attempt a process-tree kill.
 *
 * Only meaningful on win32 (RUN_INSTALLER already refuses to run anywhere
 * else) and only once the installer actually produced a pid: `spawn()` can
 * fail before a pid is assigned, in which case there is no tree to kill.
 */
export function shouldKillInstallerTree(platform: NodeJS.Platform, pid: number | undefined): pid is number {
  return platform === "win32" && typeof pid === "number"
}

/** The minimal shape `attemptInstallerTreeKill` needs from a spawned taskkill process: just enough to notice it failed to launch. */
type Killable = { on(event: "error", listener: (error: unknown) => void): unknown }

/**
 * Issues the process-tree kill for an expired RUN_INSTALLER wait and logs
 * the outcome, with `spawnFn` and `log` injected so the decision and its
 * logging can run under a unit test without a real child_process or
 * Electron's logManager (the same gap gameExecutionOutcome.ts's module
 * comment describes for pathsHandlers.ts itself).
 *
 * Fire-and-forget by design: a timed-out RUN_INSTALLER call resolves
 * immediately either way (see pathsHandlers.ts), so this only needs to
 * start the kill and record whether spawning taskkill itself failed.
 */
export function attemptInstallerTreeKill(
  pid: number | undefined,
  platform: NodeJS.Platform,
  spawnFn: (command: string, args: string[]) => Killable,
  log: (level: "error" | "debug", message: string) => void
): void {
  if (!shouldKillInstallerTree(platform, pid)) return

  const { command, args } = buildInstallerTreeKillCommand(pid)
  try {
    spawnFn(command, args).on("error", (killError) => {
      log("error", "Failed to spawn taskkill for the installer's process tree.")
      log("debug", String(killError))
    })
  } catch (killError) {
    log("error", "Failed to spawn taskkill for the installer's process tree.")
    log("debug", String(killError))
  }
}

/** RUN_INSTALLER's early refusal: the host is not Windows, so the installer is never run. */
export function notWindowsResult(): InstallerRunResult {
  return { ok: false, reason: "not-windows" }
}

/** RUN_INSTALLER's early refusal: the installer file at the given path does not exist. */
export function installerMissingResult(): InstallerRunResult {
  return { ok: false, reason: "installer-missing" }
}

/** RUN_INSTALLER's success, however it got there: payload extraction or the spawn fallback. */
export function installerOkResult(): InstallerRunResult {
  return { ok: true }
}

/** RUN_INSTALLER failed outright: extraction failed, or the fallback spawn errored, exited non-zero, or could not be started. */
export function installerFailedResult(): InstallerRunResult {
  return { ok: false, reason: "installer-failed" }
}

/** The fallback spawn ran past RUN_INSTALLER_TIMEOUT_MS and had its process tree killed. */
export function installerTimedOutResult(): InstallerRunResult {
  return { ok: false, reason: "installer-timed-out" }
}

/**
 * Maps extractInstallerPayload's terminal verdict onto the wire.
 *
 * `format-refused` is not terminal (the caller falls back to spawnInstaller
 * instead of resolving RUN_INSTALLER on it), so it has no mapping here.
 */
export function extractionOutcomeToResult(outcome: "extracted" | "failed"): InstallerRunResult {
  return outcome === "extracted" ? installerOkResult() : installerFailedResult()
}

/** Maps spawnInstaller's terminal outcome onto the wire. */
export function spawnInstallerOutcomeToResult(outcome: "installed" | "timed-out" | "failed"): InstallerRunResult {
  if (outcome === "installed") return installerOkResult()
  if (outcome === "timed-out") return installerTimedOutResult()
  return installerFailedResult()
}
