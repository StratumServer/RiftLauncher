import { ipcMain } from "electron"
import { spawn } from "node:child_process"
import fse from "fs-extra"
import { join } from "node:path"
import os from "node:os"
import { logMessage, getErrorMessage } from "@src/utils/logManager"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertManagedPath } from "@src/ipc/pathPolicy"
import { parseSafeEnvironment, validateGameInstallation, validateGameVersion } from "@src/ipc/validation"
import { getAccountSecrets, saveAccountSecrets } from "@src/ipc/accountStore"
import { getConfig } from "@src/config/configManager"
import { detectInstalledGameVersion } from "@domain/versions/detect"
import { buildGameLaunchPlan } from "@domain/versions/launch"
import { CLIENT_SETTINGS_FILE_NAME, clearForeignClientSettingsSession, writeClientSettingsSession } from "@domain/account/clientSettings"
import {
  gameProcessOutcomeToResult,
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
        await fse.writeJSON(path, document)
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
    await saveAccountSecrets(accountId, secrets)
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

        const externalApp = spawn(request.command, request.args, { env: { ...request.env }, cwd: request.cwd, shell: false, windowsHide: true })

        externalApp.stdout.resume()

        externalApp.stderr.on("data", (data) => {
          logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Vintage Story threw an error! Check verbose logs for more info.`)
          logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${data.toString().slice(0, 2_048)}`)
        })

        externalApp.on("close", (code) => settle({ started: true, exitCode: code }))

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
      mesaGlThread: safeInstallation.mesaGlThread
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
        }
      }
    )

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

  logMessage("info", "[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Running Vintagestory with a validated executable.")

  const outcome = await realGameProcess().run({ command: plan.command, args: plan.args, env: { ...process.env, ...processEnv, ...plan.env }, cwd: plan.cwd })

  if (!outcome.started) logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Failed to run Vintage Story: ${outcome.error ?? "unknown error"}.`)
  else logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Vintage Story closed: ${outcome.exitCode}`)

  return gameProcessOutcomeToResult(outcome)
})

type LookForAGameVersionResult = { exists: true; installedGameVersion: string } | { exists: false; installedGameVersion?: undefined }

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

        const settle = (outcome: ProcessProbeOutcome): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(outcome)
        }

        const externalApp = spawn(request.command, request.args, { shell: false, windowsHide: true })

        const timer = setTimeout(() => {
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
  logMessage("info", `[back] [ipc] [gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Looking for the game at ${safePath}`)

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
  return { exists: true, installedGameVersion: result.version }
})
