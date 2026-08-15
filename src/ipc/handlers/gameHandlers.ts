import { ipcMain } from "electron"
import { spawn } from "child_process"
import fse from "fs-extra"
import { join } from "path"
import os from "os"
import { logMessage } from "@src/utils/logManager"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { assertManagedPath } from "@src/ipc/pathPolicy"
import { parseSafeEnvironment, validateGameInstallation, validateGameVersion } from "@src/ipc/validation"
import { getAccountSecrets } from "@src/ipc/accountStore"
import { getConfig } from "@src/config/configManager"

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

ipcMain.handle(IPC_CHANNELS.GAME_MANAGER.LOOK_FOR_A_GAME_VERSION, async (event, path: unknown) => {
  assertTrustedIpcSender(event)
  const safePath = await assertManagedPath(path, "game version path", { allowMissing: true })
  logMessage("info", `[component] [look-for-a-game-version] Looking for the game at ${safePath}`)

  let command: string
  let params: string[]

  const res: { exists: boolean; installedGameVersion: string | undefined } = { exists: false, installedGameVersion: undefined }

  if (os.platform() === "linux") {
    logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Linux platform detected.`)

    try {
      const files = await fse.readdir(safePath)

      if (files.includes("Vintagestory")) {
        logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Vintagestory found.`)
        command = await assertExecutable(join(safePath, "Vintagestory"))
        params = [`-v`]
      } else if (files.includes("Vintagestory.exe")) {
        logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Vintagestory.exe found.`)
        command = "mono"
        params = [await assertExecutable(join(safePath, "Vintagestory.exe")), `-v`]
      } else {
        logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Couldn't find Vintage Story on that folder.`)
        return false
      }
    } catch (err) {
      logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Error looking for Vintage Story.`)
      logMessage("verbose", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Error looking for Vintage Story: ${err}`)
      return false
    }
  } else if (os.platform() === "win32") {
    logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Windows platform detected.`)

    try {
      const files = await fse.readdir(safePath)

      if (files.includes("Vintagestory.exe")) {
        logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Vintagestory found.`)
        command = await assertExecutable(join(safePath, "Vintagestory.exe"))
        params = [`-v`]
      } else {
        logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Couldn't find Vintage Story on that folder.`)
        return false
      }
    } catch (err) {
      logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Error looking for Vintage Story.`)
      logMessage("verbose", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Error looking for Vintage Story: ${err}`)
      return false
    }
  } else if (os.platform() === "darwin") {
    logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] MacOS platform detected. Not yet supported.`)
    return false
  } else {
    logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Not platform detected.`)
    return false
  }

  if (command && params) {
    const checkGameVersion = await new Promise<string | undefined>((resolve, reject) => {
      logMessage("info", "[back] [ipc] [ipc/handlers/gameHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Checking Vintage Story with a validated executable.")

      const externalApp = spawn(command, params, { shell: false, windowsHide: true })
      let versionResult: string

      externalApp.stdout.on("data", (data) => {
        logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] ${data}`)
        versionResult = data.toString().trim()
        resolve(versionResult)
      })

      externalApp.stderr.on("data", (data) => {
        logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Vintage Story threw an error! Check verbose logs for more info.`)
        logMessage("verbose", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] ${data}`)
      })

      externalApp.on("close", (code) => {
        logMessage("info", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Vintage Story closed: ${code}`)
        resolve(versionResult)
      })

      externalApp.on("error", (error) => {
        logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] Error looking for the Vintage Story version.`)
        logMessage("verbose", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] ${error}`)
        reject(undefined)
      })
    })

    res.exists = true
    res.installedGameVersion = checkGameVersion
    return res
  } else {
    logMessage("error", `[back] [ipc] [ipc/handlers/pathsHandlers.ts] [LOOK_FOR_A_GAME_VERSION] No command or params found.`)
    return res
  }
})
