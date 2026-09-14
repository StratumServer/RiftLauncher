import { ipcMain } from "electron"
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import fse from "fs-extra"
import { constants } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import os from "node:os"
import { logMessage, getErrorMessage } from "@src/utils/logManager"
import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertConfiguredInstallationPath, assertManagedPath } from "@src/ipc/pathPolicy"
import { parseSafeEnvironment, toWireBuildVariant, validateGameInstallation, validateGameVersion } from "@src/ipc/validation"
import { getAccountSecrets, saveAccountSecrets } from "@src/ipc/accountStore"
import { getConfig } from "@src/config/configManager"
import { detectInstalledGameVersion } from "@domain/versions/detect"
import { buildSessionReport, type InstalledModRef } from "@domain/gameLogs/report"
import { scanInstalledMods } from "@domain/mods/scanInstalled"
import { createScanInstalledModsPorts } from "@src/ipc/adapters/modScan"
import { buildGameLaunchPlan } from "@domain/versions/launch"
import { CLIENT_SETTINGS_FILE_NAME, clearForeignClientSettingsSession, writeClientSettingsSession } from "@domain/account/clientSettings"
import { MODS_FOLDER_NAME } from "@domain/mods/folder"
import {
  appendStderrScan,
  gameProcessOutcomeToResult,
  hasMissingDotnetSentinel,
  invalidExecutableResult,
  invalidRequestResult,
  launchPlanFailureResult,
  noExecutableResult,
  sessionWriteFailedResult
} from "@src/ipc/handlers/gameExecutionOutcome"
import type { AccountSecrets } from "@domain/account/credentials"
import type {
  GameProcess,
  GameProcessOutcome,
  GameProcessRequest,
  JsonFile,
  JsonFileReadResult,
  JsonFileWriteResult,
  PathBuilder,
  ProcessProbe,
  ProcessProbeOutcome,
  ProcessProbeRequest
} from "@domain/ports"

async function assertExecutable(pathValue: string): Promise<string> {
  const stats = await fse.lstat(pathValue)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Invalid game executable")
  return pathValue
}

const paths: PathBuilder = { join: async (parts: string[]): Promise<string> => join(...parts) }

/**
 * Resolves a user-selected Linux wrapper to an absolute executable, with no shell.
 *
 * A bare name is looked up in the launcher's own PATH, an absolute path is taken as given, and
 * anything relative is refused: a relative command is resolved against the spawned process's
 * working directory, which is the game version folder rather than wherever the player was thinking
 * of. PATH entries that are themselves relative are skipped for the same reason, so what `fse.stat`
 * checks and what `spawn` runs cannot be two different files. The lookup can read `process.env.PATH`
 * and the spawn can trust what it returns because PATH is in `DENIED_ENVIRONMENT_KEYS`, so an
 * installation's own environment variables cannot move it out from under this. That also matters
 * for `mono`, which the plan still passes as a bare name for the child to resolve.
 *
 * Handing the bare name straight to `spawn` would work, since `execvp` searches PATH itself.
 * Resolving first is what lets a missing, non-executable or directory wrapper be refused before the
 * client settings file is written, and what puts the real path in the log line.
 *
 * `stat` follows symlinks here, unlike the `lstat` in `assertExecutable` above. The asymmetry is
 * deliberate: a game executable that is a symlink means the version folder is not what the launcher
 * installed, while `/usr/bin/gamemoderun` and friends are symlinks on most distributions and
 * refusing them would refuse the feature. The gap between this check and the spawn that follows is
 * the same one `assertExecutable` has always had.
 *
 * What this cannot give the launcher is a hold on the game once a wrapper hands it off.
 * `realGameProcess` settles on `close`, which waits for the child's stdio pipes rather than for a
 * pid, so a wrapper that execs the game (`gamemoderun`, `mangohud`, `prime-run`), or even
 * backgrounds it while it keeps those pipes, still keeps the launcher waiting for the real session.
 * A wrapper that detaches properly, giving the game fresh stdio through `setsid` or a redirect,
 * ends the launcher's session early: the game keeps running, but the app stops being held open, the
 * installation stops reading as playing, and the playtime recorded is the wrapper's lifetime.
 */
async function resolveLaunchWrapper(value: string): Promise<string | undefined> {
  const wrapper = value.trim()
  if (!wrapper) return undefined

  const candidates = isAbsolute(wrapper)
    ? [wrapper]
    : wrapper.includes("/") || wrapper.includes("\\")
      ? []
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter((directory) => isAbsolute(directory))
          .map((directory) => join(directory, wrapper))

  for (const candidate of candidates) {
    try {
      const stats = await fse.stat(candidate)
      await fse.access(candidate, constants.X_OK)
      if (stats.isFile()) return candidate
    } catch {
      // Try the next PATH entry. The final undefined is the user-facing launch refusal.
    }
  }

  return undefined
}

/**
 * Whole-document JSON reads and writes, with a missing file reported as an
 * absent document rather than as a failure.
 *
 * The split matters for the game's settings file: no file means the launcher
 * writes a fresh one, a file that exists but holds no readable JSON means it
 * writes nothing at all.
 */
function realJsonFile(): JsonFile {
  return {
    read: async (path: string): Promise<JsonFileReadResult> => {
      try {
        if (!(await fse.pathExists(path))) return { ok: true, document: undefined }
        return { ok: true, document: await fse.readJSON(path, "utf-8") }
      } catch (err) {
        return { ok: false, error: getErrorMessage(err) }
      }
    },
    write: async (path: string, document: unknown): Promise<JsonFileWriteResult> => {
      try {
        await writeJsonAtomic(path, document)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: getErrorMessage(err) }
      }
    }
  }
}

/**
 * Stores the session the game refreshed for this account, so the next launch
 * stops overwriting it.
 *
 * This is the same encrypted store LOGIN writes to and the same function it
 * calls, which is the point: there is one place a session is kept and one way
 * in. The launch goes ahead whether this lands or not. The game's own settings
 * file already holds the working session, so a store that refuses the update
 * costs the player another login prompt next launch, and failing the launch
 * over it would cost them the game they asked for.
 *
 * Nothing here goes near the key itself. What gets logged is that an adoption
 * happened, never what was adopted.
 */
async function adoptRefreshedSession(accountId: string, secrets: AccountSecrets): Promise<void> {
  try {
    const outcome = await saveAccountSecrets(accountId, secrets)
    if (outcome === "saved-after-rebuild")
      logMessage(
        "warn",
        `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] The account store could not be read; it was copied aside and rebuilt around this adoption. Other saved accounts must log in again.`
      )
    logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] The game had already refreshed this account's session. Adopted it instead of overwriting it.`)
  } catch (err) {
    logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Could not store the session the game refreshed. Launching anyway.`)
    logMessage("debug", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${getErrorMessage(err)}`)
  }
}

/**
 * Runs the game and resolves when the player closes it.
 *
 * Stdout is drained and thrown away so a chatty game can never fill its pipe
 * and block on it, stderr is logged in verbose truncated to 2 KiB, and the exit
 * code is reported without being judged: Vintage Story exits non-zero often
 * enough that reading that as a failed launch would tell a player their session
 * went wrong after they closed it themselves.
 *
 * The one thing stderr is read for is the .NET host's fixed missing-runtime
 * sentence, which is what a player gets instead of a game when the build needs
 * a runtime major version they have not installed (issue #397). The scan
 * accumulates a bounded head of stderr so the sentence still matches when it
 * arrives split across two chunks, and only a boolean leaves this function:
 * the version the host wanted and the paths it searched stay in the verbose
 * log they were already written to.
 */
function realGameProcess(): GameProcess {
  return {
    run: async (request: GameProcessRequest): Promise<GameProcessOutcome> =>
      new Promise<GameProcessOutcome>((resolve) => {
        let settled = false

        const settle = (outcome: GameProcessOutcome): void => {
          if (settled) return
          settled = true
          resolve(outcome)
        }

        let externalApp: ChildProcessWithoutNullStreams
        try {
          externalApp = spawn(request.command, request.args, { env: { ...request.env }, cwd: request.cwd, shell: false, windowsHide: true })
        } catch (err) {
          // spawn reports ENOENT, EACCES, EAGAIN, EMFILE and ENFILE through an "error"
          // event and THROWS everything else, which is not a distinction the caller can
          // do anything with. Windows answers a file that is not a real executable with
          // UNKNOWN, so a truncated or quarantined Vintagestory.exe lands here rather
          // than on the event below; without this the whole handler rejects and the
          // launch stops being a reason the player is told.
          logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error running Vintage Story.`)
          logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${getErrorMessage(err)}`)
          settle({ started: false, error: getErrorMessage(err) })
          return
        }

        externalApp.stdout.resume()

        let stderrScan = ""

        externalApp.stderr.on("data", (data) => {
          const text = data.toString()
          stderrScan = appendStderrScan(stderrScan, text)
          logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Vintage Story threw an error! Check verbose logs for more info.`)
          logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${text.slice(0, 2_048)}`)
        })

        externalApp.on("close", (code) => settle({ started: true, exitCode: code, missingRuntime: hasMissingDotnetSentinel(stderrScan) }))

        externalApp.on("error", (error) => {
          logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error running Vintage Story.`)
          logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${error}`)
          settle({ started: false, error: getErrorMessage(error) })
        })
      })
  }
}

/**
 * Starts a game version with an installation and resolves when the player quits.
 *
 * Resolves a typed {@link GameExecutionResult}: `ok: true` once the game
 * exits, whatever exit code it exits with, `ok: false` with a reason when it
 * never ran. Every refusal below is a flow a player can reach through normal
 * use, so all of them resolve rather than reject. The checks ahead of them
 * (trusted sender, request shape, managed paths) stay throws: those guard
 * against a hostile renderer, not against a player whose game would not
 * start, and turning them into reasons would blur that line.
 */
ipcMain.handle(IPC_CHANNELS.GAME_MANAGER.EXECUTE_GAME, async (event, version: unknown, installation: unknown): Promise<GameExecutionResult> => {
  assertTrustedIpcSender(event)
  const safeVersion = validateGameVersion(version)
  const safeInstallation = validateGameInstallation(installation)
  if ((safeVersion.id !== undefined || safeInstallation.gameVersionId !== undefined) && safeVersion.id !== safeInstallation.gameVersionId) {
    throw new TypeError("Game version and installation gameVersionId do not correlate")
  }
  safeVersion.path = await assertManagedPath(safeVersion.path, "game version path")
  safeInstallation.path = await assertManagedPath(safeInstallation.path, "installation path")
  const config = await getConfig()
  const account = config.accounts.find((candidate) => candidate.playerUid === config.activeAccountId) ?? null
  const accountSecrets = account ? await getAccountSecrets(account.playerUid) : null
  logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Trying to run Vintage Story ${safeVersion.version}.`)

  let processEnv: Record<string, string>
  try {
    processEnv = parseSafeEnvironment(safeInstallation.envVars)
  } catch (err) {
    logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Refused invalid environment variables for this installation.`)
    logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${getErrorMessage(err)}`)
    return invalidRequestResult()
  }

  let launchWrapper = ""
  if (os.platform() === "linux" && safeInstallation.launchWrapper) {
    const resolvedWrapper = await resolveLaunchWrapper(safeInstallation.launchWrapper)
    if (!resolvedWrapper) {
      logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Refused an unavailable or non-executable launch wrapper.`)
      return invalidExecutableResult()
    }
    launchWrapper = resolvedWrapper
  }

  let fileNames: string[]
  try {
    fileNames = await fse.readdir(safeVersion.path)
  } catch (err) {
    logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error detecting how to run Vintage Story.`)
    logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error detecting how to run Vintage Story: ${getErrorMessage(err)}`)
    return noExecutableResult()
  }

  const planned = await buildGameLaunchPlan(
    { paths },
    {
      platform: os.platform(),
      versionFolder: safeVersion.path,
      fileNames,
      installationPath: safeInstallation.path,
      startParams: safeInstallation.startParams,
      mesaGlThread: safeInstallation.mesaGlThread,
      launchWrapper
    }
  )

  if (!planned.ok) {
    logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Couldn't find a way to run Vintage Story on ${os.platform()} (${planned.reason}), aborting...`)
    return launchPlanFailureResult(planned.reason)
  }

  const plan = planned.plan

  try {
    await assertExecutable(plan.executablePath)
  } catch (err) {
    logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Refused to run an invalid game executable.`)
    logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${getErrorMessage(err)}`)
    return invalidExecutableResult()
  }

  if (account && accountSecrets) {
    logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Logged in. Setting session keys.`)

    let settingsPath: string
    try {
      settingsPath = await assertManagedPath(join(safeInstallation.path, CLIENT_SETTINGS_FILE_NAME), "client settings", { allowMissing: true })
    } catch (err) {
      logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error setting login session keys.`)
      logMessage("debug", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Refused the client settings path: ${getErrorMessage(err)}`)
      return sessionWriteFailedResult()
    }

    const modsPath = join(safeInstallation.path, MODS_FOLDER_NAME)

    const written = await writeClientSettingsSession(
      { jsonFile: realJsonFile() },
      {
        settingsPath,
        session: {
          mptoken: accountSecrets.mptoken,
          sessionKey: accountSecrets.sessionKey,
          sessionSignature: accountSecrets.sessionSignature,
          email: account.email,
          playerEntitlements: account.playerEntitlements,
          playerUid: account.playerUid,
          playerName: account.playerName,
          hostGameServer: account.hostGameServer
        },
        modPaths: { installationPath: safeInstallation.path, modsPath }
      }
    )

    // Never logs what the file held: the path this installation was copied out of is untrusted
    // input and stays out of the log. The path we put there is our own and may be named.
    const modPathsNotice = "modPaths" in written ? written.modPaths : undefined
    if (modPathsNotice === "repointed") logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Repointed this installation's mod folder list at [PATH].`)
    else if (modPathsNotice === "repoint-write-failed")
      logMessage(
        "warn",
        `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] This installation's mod folder list needed repointing but the settings file could not be written; the game's own session was kept.`
      )
    else if (modPathsNotice === "left-as-found")
      logMessage("warn", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] This installation's mod folder list is not the game's default one and was left as found.`)

    switch (written.outcome) {
      case "written":
        break
      case "adopted":
        await adoptRefreshedSession(account.playerUid, written.secrets)
        break
      case "unreadable-settings":
      case "write-failed":
        logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error setting login session keys.`)
        logMessage("debug", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error setting login session keys: ${written.outcome}.`)
        return sessionWriteFailedResult()
    }
  } else if (account && !accountSecrets) {
    // The active account has no usable session (a locked keyring, or a store this build cannot
    // read). With one saved account that was always harmless: whatever stale session the file
    // already held was that same account's own. With more than one it can be a housemate's,
    // since the game writes their session there directly on their own successful login, and
    // launching without checking would start the game already signed in as somebody else.
    // Narrow on purpose: this only clears the file when it demonstrably holds a DIFFERENT
    // player's session, never our own and never an empty one, and it never writes a session of
    // its own; that stays writeClientSettingsSession's job above.
    let settingsPath: string
    try {
      settingsPath = await assertManagedPath(join(safeInstallation.path, CLIENT_SETTINGS_FILE_NAME), "client settings", { allowMissing: true })
    } catch (err) {
      logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error checking for another player's session keys.`)
      logMessage("debug", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Refused the client settings path: ${getErrorMessage(err)}`)
      return sessionWriteFailedResult()
    }

    const cleared = await clearForeignClientSettingsSession({ jsonFile: realJsonFile() }, { settingsPath, playerUid: account.playerUid })

    switch (cleared.outcome) {
      case "cleared":
        logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Cleared another player's session before launching without one of our own.`)
        break
      case "not-foreign":
        break
      case "unreadable-settings":
      case "write-failed":
        logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Could not confirm this installation is not still signed in as another player.`)
        logMessage("debug", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${cleared.outcome}.`)
        return sessionWriteFailedResult()
    }
  }

  logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Running Vintagestory with a validated executable${launchWrapper ? ` through ${launchWrapper}` : ""}.`)

  const outcome = await realGameProcess().run({ command: plan.command, args: plan.args, env: { ...process.env, ...processEnv, ...plan.env }, cwd: plan.cwd })

  if (!outcome.started)
    logMessage(
      "error",
      `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Failed to run Vintage Story${launchWrapper ? ` through ${launchWrapper}` : ""}: ${outcome.error ?? "unknown error"}.`
    )
  else logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Vintage Story closed: ${outcome.exitCode}`)

  return gameProcessOutcomeToResult(outcome)
})

type LookForAGameVersionResult = { exists: true; installedGameVersion: string; variant?: GameBuildVariantType } | { exists: false; installedGameVersion?: undefined }

const NOT_FOUND: LookForAGameVersionResult = { exists: false }

/** How long a probed executable is given to print its version before it is treated as hung. */
const LOOK_FOR_A_GAME_VERSION_PROBE_TIMEOUT_MS = 10_000

/**
 * Spawns one process and reports what it printed to stdout, bounded by
 * {@link LOOK_FOR_A_GAME_VERSION_PROBE_TIMEOUT_MS}.
 *
 * The timeout is the one deliberate behavior change from the handler this
 * replaced: the previous implementation had nothing stopping it from waiting
 * on a hung game binary forever, which meant the "look for a version" dialog
 * could hang with it. Everything else here mirrors what that handler did:
 * the executable is validated with the same {@link assertExecutable} check
 * EXECUTE_GAME uses, stderr is logged but never fails the probe on its own,
 * and the process is run with `shell: false` and `windowsHide: true`.
 *
 * A configured launch wrapper is deliberately not applied here. The probe runs
 * the executable with `-v` and reads the version off stdout, and nothing a
 * wrapper does changes what that prints.
 */
function realProcessProbe(): ProcessProbe {
  return {
    run: async (request: ProcessProbeRequest): Promise<ProcessProbeOutcome> => {
      try {
        await assertExecutable(request.command === "mono" ? (request.args[0] ?? "") : request.command)
      } catch (err) {
        logMessage("error", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Refused to probe an invalid executable.`)
        logMessage("verbose", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] ${getErrorMessage(err)}`)
        return { ok: false, stdout: "", error: getErrorMessage(err) }
      }

      return new Promise<ProcessProbeOutcome>((resolve) => {
        logMessage("info", "[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Checking Vintage Story with a validated executable.")

        let stdout = ""
        let settled = false
        // Declared before settle so that every exit from this executor, the spawn
        // throw included, goes through settle. clearTimeout ignores undefined, so
        // settling before the timer exists is safe.
        let timer: ReturnType<typeof setTimeout> | undefined = undefined

        const settle = (outcome: ProcessProbeOutcome): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(outcome)
        }

        let externalApp: ChildProcessWithoutNullStreams
        try {
          externalApp = spawn(request.command, request.args, { shell: false, windowsHide: true })
        } catch (err) {
          // Same throw-instead-of-emit split as EXECUTE_GAME's spawn above, settled
          // the way the "error" event below settles it.
          logMessage("error", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Error looking for the Vintage Story version.`)
          logMessage("verbose", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] ${getErrorMessage(err)}`)
          settle({ ok: false, stdout, error: getErrorMessage(err) })
          return
        }

        timer = setTimeout(() => {
          logMessage("error", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Timed out waiting for Vintage Story to report its version.`)
          externalApp.kill()
          settle({ ok: false, stdout, error: "Timed out waiting for a response." })
        }, LOOK_FOR_A_GAME_VERSION_PROBE_TIMEOUT_MS)

        externalApp.stdout.on("data", (data) => {
          stdout += data.toString()
        })

        externalApp.stderr.on("data", (data) => {
          logMessage("error", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Vintage Story threw an error! Check verbose logs for more info.`)
          logMessage("verbose", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] ${data}`)
        })

        externalApp.on("close", (code) => {
          logMessage("info", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Vintage Story closed: ${code}`)
          settle({ ok: true, stdout })
        })

        externalApp.on("error", (error) => {
          logMessage("error", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Error looking for the Vintage Story version.`)
          logMessage("verbose", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] ${error}`)
          settle({ ok: false, stdout, error: getErrorMessage(error) })
        })
      })
    }
  }
}

ipcMain.handle(IPC_CHANNELS.GAME_MANAGER.LOOK_FOR_A_GAME_VERSION, async (event, path: unknown): Promise<LookForAGameVersionResult> => {
  assertTrustedIpcSender(event)
  const safePath = await assertManagedPath(path, "game version path", { allowMissing: true })
  logMessage("info", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Looking for the game at [PATH]`)

  let fileNames: string[]
  try {
    fileNames = await fse.readdir(safePath)
  } catch (err) {
    logMessage("error", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Error reading the folder.`)
    logMessage("verbose", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] ${getErrorMessage(err)}`)
    return NOT_FOUND
  }

  const result = await detectInstalledGameVersion({ paths, processProbe: realProcessProbe() }, { platform: os.platform(), folder: safePath, fileNames })

  if (!result.ok) {
    logMessage("info", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] No version found: ${result.reason}.`)
    return NOT_FOUND
  }

  logMessage("info", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Found Vintage Story ${result.version}.`)
  const variant = toWireBuildVariant(result.variant)
  return variant ? { exists: true, installedGameVersion: result.version, variant } : { exists: true, installedGameVersion: result.version }
})

/**
 * Reading the last session's own logs, for the report on `/installations/report/:id` (#462).
 *
 * Nothing read here ever reaches the launcher's own log, not even at verbose: these files carry the
 * player's paths, and the domain redacts every string the report keeps before it crosses IPC. The
 * one line this logs carries counts and fixed tokens.
 *
 * The renderer names an Installation and never a file. The handler joins the two names it knows and
 * puts each through the read-only grade #237 added for linked data folders, so a player who keeps
 * their data folder behind a symbolic link still gets a report, while nothing outside the
 * Installation the config names can be reached. `client-debug.log`, the chat and audit logs and the
 * server files are not opened at all.
 */
const GAME_LOGS_FOLDER_NAME = "Logs"
const CLIENT_MAIN_LOG_FILE_NAME = "client-main.log"
const CLIENT_CRASH_FILE_NAME = "client-crash.txt"

/** Under this, the log is read whole. A real session writes a few hundred KiB. */
const WHOLE_LOG_BYTES = 2 * 1024 * 1024
/** The phase timeline and the mod roster live at the top of the file. */
const LOG_HEAD_BYTES = 512 * 1024
/** The errors and the crash live at the bottom. */
const LOG_TAIL_BYTES = 1536 * 1024
/** A crash file is a header and a trace. Past this it is a payload, and only its head is read. */
const CRASH_FILE_BYTES = 256 * 1024

interface BoundedRead {
  text: string
  truncated: boolean
  lastWrittenAtMs: number
}

/**
 * Reads a file whole under `whole` bytes, and head plus tail above it.
 *
 * `stat`, not `lstat`: this is the grade that admits a linked data folder, so following the link is
 * the point. A missing file, a folder, or anything that is not a regular file answers null, which
 * the caller reads as "there is no such log" rather than as a failure.
 *
 * The cut is by bytes, not by lines, so each half can begin or end mid-character and mid-line. A
 * replacement character inside one line costs that line and nothing else, and the two half lines at
 * the cuts are dropped here: the head's is a sentence with its end missing, and joining it to the
 * tail's, which comes from megabytes later in the file, would make one line out of two unrelated
 * fragments for the line grammar to hand to whichever entry came before.
 */
async function readBoundedText(filePath: string, whole: number, head: number, tail: number): Promise<BoundedRead | null> {
  const stats = await fse.stat(filePath).catch(() => null)
  if (!stats || !stats.isFile()) return null
  if (stats.size <= whole) return { text: await fse.readFile(filePath, "utf-8"), truncated: false, lastWrittenAtMs: stats.mtimeMs }

  const handle = await fse.open(filePath, "r")
  try {
    const headBuffer = Buffer.alloc(head)
    await fse.read(handle, headBuffer, 0, head, 0)
    const headText = headBuffer.toString("utf-8")
    const headLines = headText.slice(0, Math.max(headText.lastIndexOf("\n"), 0))
    if (tail <= 0) return { text: headLines, truncated: true, lastWrittenAtMs: stats.mtimeMs }

    const tailBuffer = Buffer.alloc(tail)
    await fse.read(handle, tailBuffer, 0, tail, stats.size - tail)
    const tailText = tailBuffer.toString("utf-8")
    const firstBreak = tailText.indexOf("\n")
    return { text: `${headLines}\n${firstBreak === -1 ? "" : tailText.slice(firstBreak + 1)}`, truncated: true, lastWrittenAtMs: stats.mtimeMs }
  } finally {
    await fse.close(handle)
  }
}

/** The Mods the launcher recognises, so an assembly or a Harmony id can be tied to one and a group can carry a name. */
async function readInstalledModRefs(installationPath: string): Promise<InstalledModRef[]> {
  try {
    const folder = await assertManagedPath(join(installationPath, MODS_FOLDER_NAME), "mods path", { allowMissing: true, allowSymlinks: true })
    if (!(await fse.pathExists(folder))) return []
    const scan = await scanInstalledMods(createScanInstalledModsPorts(), { folder })
    return scan.mods.map((mod) => ({ modid: mod.modid, name: mod.name }))
  } catch {
    // A Mods folder that cannot be read costs the report its display names and its assembly rule,
    // and nothing else. The bracket rule reads the log line itself and still works.
    return []
  }
}

ipcMain.handle(IPC_CHANNELS.GAME_MANAGER.GET_GAME_LOG_REPORT, async (event, installationPath: unknown): Promise<GameLogReportResult> => {
  assertTrustedIpcSender(event)

  let installation: string
  try {
    installation = await assertConfiguredInstallationPath(installationPath)
  } catch {
    logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [GET_GAME_LOG_REPORT] Refused: not a configured Installation.`)
    return { ok: false, reason: "refused" }
  }

  let mainLog: BoundedRead | null
  let crashFile: BoundedRead | null
  try {
    const readOnly = { allowMissing: true, allowSymlinks: true } as const
    const logsFolder = join(installation, GAME_LOGS_FOLDER_NAME)
    const mainLogPath = await assertManagedPath(join(logsFolder, CLIENT_MAIN_LOG_FILE_NAME), "game log path", readOnly)
    const crashPath = await assertManagedPath(join(logsFolder, CLIENT_CRASH_FILE_NAME), "game crash path", readOnly)
    mainLog = await readBoundedText(mainLogPath, WHOLE_LOG_BYTES, LOG_HEAD_BYTES, LOG_TAIL_BYTES)
    crashFile = await readBoundedText(crashPath, CRASH_FILE_BYTES, CRASH_FILE_BYTES, 0)
  } catch (err) {
    logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [GET_GAME_LOG_REPORT] Could not read this Installation's logs.`)
    logMessage("debug", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [GET_GAME_LOG_REPORT] ${getErrorMessage(err)}`)
    return { ok: false, reason: "unreadable" }
  }

  if (!mainLog && !crashFile) {
    logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [GET_GAME_LOG_REPORT] No session logs to read yet.`)
    return { ok: false, reason: "no-logs" }
  }

  const config = await getConfig()
  const report = buildSessionReport({
    ...(mainLog ? { mainLog: { fileName: CLIENT_MAIN_LOG_FILE_NAME, text: mainLog.text, lastWrittenAtMs: mainLog.lastWrittenAtMs, truncated: mainLog.truncated } } : {}),
    ...(crashFile ? { crashFile: { text: crashFile.text } } : {}),
    installedMods: await readInstalledModRefs(installation),
    // The pattern redactor cannot recognise an email or a player name, so they are masked by value.
    accountValues: config.accounts.flatMap((account) => [account.email, account.playerName])
  })

  logMessage(
    "info",
    `[back] [ipc] [ipc/handlers/gameHandlers.ts] [GET_GAME_LOG_REPORT] Built a session report: ${report.mods.length} groups, ${report.unattributed.length} other lines, crash ${report.crash ? 1 : 0}, truncated ${report.source.truncated ? 1 : 0}.`
  )
  return { ok: true, report }
})
