/**
 * Pure helpers for RUN_INSTALLER's bounded wait.
 *
 * pathsHandlers.ts calls ipcMain.handle at module load, which needs a
 * running Electron main process and so cannot be imported directly by a unit
 * test (the same gap tracked in issue #27 for gameHandlers.ts). The
 * timeout/kill decision itself touches neither Electron nor a live
 * child_process, so it is pulled out here where a test can pin it without
 * standing up the app (mirrors gameExecutionOutcome.ts, written for the same
 * reason).
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
