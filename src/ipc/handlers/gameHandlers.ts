import { ipcMain } from "electron"
import { spawn } from "child_process"
import fse from "fs-extra"
import { join } from "path"
import os from "os"
import { logMessage, getErrorMessage } from "@src/utils/logManager"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertManagedPath } from "@src/ipc/pathPolicy"
import { parseSafeEnvironment, validateGameInstallation, validateGameVersion } from "@src/ipc/validation"
import { getAccountSecrets } from "@src/ipc/accountStore"
import { getConfig } from "@src/config/configManager"
import { detectInstalledGameVersion } from "@domain/versions/detect"
import type { PathBuilder, ProcessProbe, ProcessProbeOutcome, ProcessProbeRequest } from "@domain/ports"

async function assertExecutable(pathValue: string): Promise<string> {
  const stats = await fse.lstat(pathValue)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Invalid game executable")
  return pathValue
}

ipcMain.handle(IPC_CHANNELS.GAME_MANAGER.EXECUTE_GAME, async (event, version: unknown, installation: unknown): Promise<boolean> => {
  assertTrustedIpcSender(event)
  const safeVersion = validateGameVersion(version)
  const safeInstallation = validateGameInstallation(installation)
  safeVersion.path = await assertManagedPath(safeVersion.path, "game version path")
  safeInstallation.path = await assertManagedPath(safeInstallation.path, "installation path")
  const account = (await getConfig()).account
  const accountSecrets = account ? await getAccountSecrets() : null
  logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Trying to run Vintage Story ${safeVersion.version}.`)

  const processEnv = parseSafeEnvironment(safeInstallation.envVars)

  let command: string
  let params: string[]
  let env: NodeJS.ProcessEnv = { ...process.env, ...processEnv }

  if (os.platform() === "linux") {
    logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Linux platform detected.`)

    try {
      const files = await fse.readdir(safeVersion.path)

      if (files.includes("Vintagestory")) {
        logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Vintagestory found.`)
        command = await assertExecutable(join(safeVersion.path, "Vintagestory"))
        params = [`--dataPath=${safeInstallation.path}`, safeInstallation.startParams]
        if (safeInstallation.mesaGlThread) env = { ...env, MESA_GLTHREAD: "true" }
      } else if (files.includes("Vintagestory.exe")) {
        logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Vintagestory.exe found.`)
        command = "mono"
        params = [await assertExecutable(join(safeVersion.path, "Vintagestory.exe")), `--dataPath=${safeInstallation.path}`, safeInstallation.startParams]
      } else {
        logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Couldn't find a way to run Vintage Story, aborting...`)
        return false
      }
    } catch (err) {
      logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error detecting how to run Vintage Story.`)
      logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error detecting how to run Vintage Story: ${err}`)
      return false
    }
  } else if (os.platform() === "win32") {
    logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Windows platform detected.`)

    try {
      const files = await fse.readdir(safeVersion.path)

      if (files.includes("Vintagestory.exe")) {
        logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Vintagestory found.`)
        command = await assertExecutable(join(safeVersion.path, "Vintagestory.exe"))
        params = [`--dataPath=${safeInstallation.path}`, safeInstallation.startParams]
      } else {
        logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Couldn't find a way to run Vintage Story, aborting...`)
        return false
      }
    } catch (err) {
      logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error detecting how to run Vintage Story.`)
      logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error detecting how to run Vintage Story: ${err}`)
      return false
    }
  } else if (os.platform() === "darwin") {
    logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] MacOS platform detected. Not yet supported.`)
    return false
  } else {
    logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Not platform detected.`)
    return false
  }

  if (command && params) {
    if (account && accountSecrets) {
      logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Logged in. Setting session keys.`)

      try {
        const clientsettingsPath = await assertManagedPath(join(safeInstallation.path, "clientsettings.json"), "client settings", { allowMissing: true })
        const clientsettings = (await fse.pathExists(clientsettingsPath)) ? await fse.readJSON(clientsettingsPath, "utf-8") : {}
        const stringSettings =
          clientsettings && typeof clientsettings === "object" && !Array.isArray(clientsettings) && typeof clientsettings.stringSettings === "object" && clientsettings.stringSettings !== null
            ? clientsettings.stringSettings
            : {}

        await fse.writeJSON(clientsettingsPath, {
          ...clientsettings,
          stringSettings: {
            ...stringSettings,
            mptoken: accountSecrets.mptoken,
            sessionkey: accountSecrets.sessionKey,
            sessionsignature: accountSecrets.sessionSignature,
            useremail: account.email,
            entitlements: account.playerEntitlements,
            playeruid: account.playerUid,
            playername: account.playerName,
            hostgameserver: account.hostGameServer
          }
        })
      } catch (err) {
        logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error setting login session keys.`)
        logMessage("debug", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error setting login session keys: ${err}`)
        return false
      }
    }

    logMessage("info", "[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Running Vintagestory with a validated executable.")

    return new Promise((resolve, reject) => {
      const externalApp = spawn(command, params, { env, cwd: safeVersion.path, shell: false, windowsHide: true })

      externalApp.stdout.resume()

      externalApp.stderr.on("data", (data) => {
        logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Vintage Story threw an error! Check verbose logs for more info.`)
        logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${data.toString().slice(0, 2_048)}`)
      })

      externalApp.on("close", (code) => {
        logMessage("info", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Vintage Story closed: ${code}`)
        resolve(true)
      })

      externalApp.on("error", (error) => {
        logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] Error running Vintage Story.`)
        logMessage("verbose", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] ${error}`)
        reject(false)
      })
    })
  } else {
    logMessage("error", `[back] [ipc] [ipc/handlers/gameHandlers.ts] [EXECUTE_GAME] No command or params found.`)
    return false
  }
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

const paths: PathBuilder = { join: async (parts: string[]): Promise<string> => join(...parts) }

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
