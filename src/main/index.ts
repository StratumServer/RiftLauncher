import { app, shell, BrowserWindow, protocol, net, session, Menu } from "electron"
import { dirname, join } from "path"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"
import { autoUpdater } from "electron-updater"
import Logger from "electron-log"
import { pathToFileURL } from "url"
import { describeUserDataSetup, setUpUserDataFolder } from "@src/main/userDataMigration"

const userDataSetup = setUpUserDataFolder(app.getPath("appData"))
app.setPath("userData", userDataSetup.path)

import { ensureConfig, flushConfigWrites, getConfig, saveConfig } from "@src/config/configManager"
import { getShouldPreventClose } from "@src/utils/shouldPreventClose"
import icon from "../../resources/icon.png?asset"
import { logMessage } from "@src/utils/logManager"
import { createUpdaterLogger } from "@src/utils/updaterLogger"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { registerTrustedWebContents } from "@src/ipc/ipcSecurity"
import { assertAllowedBrowserUrl, isAllowedRendererUrl, resolveContainedPath } from "@src/ipc/validation"
import { terminateActiveWorkers } from "@src/ipc/workerManager"
import { markUpdateDownloaded } from "@src/ipc/handlers/appUpdaterHandlers"
import { canAutoUpdate } from "@domain/appUpdate/canAutoUpdate"
import fse from "fs-extra"

import "@src/ipc"
import { clearTimeout, setTimeout } from "timers"

Logger.transports.file.resolvePathFn = (variables, message): string => {
  const logsPath = join(variables.userData, "Logs")
  if (!message) return join(logsPath, "default.log")
  return join(logsPath, `${message.level}.log`)
}

logMessage("info", `[back] [index] [main/index.ts] [setUpUserDataFolder] ${describeUserDataSetup(userDataSetup)}`)

// electron-updater's own constructor already attaches an "error" listener that logs
// error.stack || error.message through whatever logger it is given, so a hand-written
// listener here would be redundant. What it was given until now was the raw electron-log
// instance, the one component writing to disk without passing through logMessage, so the
// updater's cache paths and feed URLs escaped the redaction every other line gets.
// Placed after resolvePathFn so nothing is logged before the app's Logs directory exists.
autoUpdater.logger = createUpdaterLogger()

let mainWindow: BrowserWindow
const packagedRendererPath = join(__dirname, "../renderer/index.html")
const packagedRendererRoot = dirname(packagedRendererPath)

if (!is.dev) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        codeCache: true
      }
    }
  ])
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    center: true,
    width: 1280,
    height: 720,
    title: `RiftLauncher - ${app.getVersion()}`,
    show: false,
    autoHideMenuBar: true,
    fullscreenable: false,
    minWidth: 1024,
    minHeight: 600,
    icon: icon,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The launcher has no prose input (installation names, start params and env vars
      // are the only text fields) and no context menu anywhere in the app, so spelling
      // suggestions were never reachable. What it did cost was real: a fresh profile
      // downloads a multi-megabyte hunspell dictionary from a third-party CDN into
      // userData/Dictionaries at startup and keeps the spellcheck service alive for it.
      // This flag alone does not reliably stop that download; see the session-level
      // setSpellCheckerEnabled(false) call in the whenReady handler below.
      spellcheck: false,
      preload: join(__dirname, "../preload/index.js")
    }
  })

  registerTrustedWebContents(mainWindow.webContents)

  const isAllowedMainFrameUrl = (url: string): boolean => isAllowedRendererUrl(url, is.dev ? process.env["ELECTRON_RENDERER_URL"] : undefined, packagedRendererPath)

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logMessage("error", `[back] [index] [main/index.ts] [createWindow] Renderer process exited: ${details.reason}.`)
  })

  mainWindow.webContents.on("unresponsive", () => {
    logMessage("warn", "[back] [index] [main/index.ts] [createWindow] Renderer became unresponsive.")
  })

  mainWindow.webContents.on("responsive", () => {
    logMessage("info", "[back] [index] [main/index.ts] [createWindow] Renderer became responsive again.")
  })

  mainWindow.on("ready-to-show", async () => {
    logMessage("info", "[back] [index] [main/index.ts] [createWindow] Main window ready to show. Opening.")

    const config = await getConfig()
    const oldWindowsState = config.window

    mainWindow.setBounds({ width: oldWindowsState.width, height: oldWindowsState.height }, true)
    mainWindow.setPosition(oldWindowsState.x, oldWindowsState.y, true)
    if (oldWindowsState.maximized) mainWindow.maximize()

    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const safeUrl = assertAllowedBrowserUrl(details.url)
      void shell.openExternal(safeUrl.toString())
    } catch {
      logMessage("warn", "[back] [index] [main/index.ts] [createWindow] Blocked an unsafe external window URL.")
    }
    return { action: "deny" }
  })

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedMainFrameUrl(url)) event.preventDefault()
  })

  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedMainFrameUrl(url)) event.preventDefault()
  })

  mainWindow.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame && !isAllowedMainFrameUrl(details.url)) details.preventDefault()
  })

  let savePositionTimeout: NodeJS.Timeout | null = null

  function setSavePositionTimeout(): void {
    if (savePositionTimeout) clearTimeout(savePositionTimeout)

    savePositionTimeout = setTimeout(() => {
      saveCurrentWindowState()
    }, 1_000)
  }

  mainWindow.on("resize", () => {
    setSavePositionTimeout()
  })

  mainWindow.on("move", () => {
    setSavePositionTimeout()
  })

  mainWindow.on("close", (e) => {
    if (getShouldPreventClose()) {
      e.preventDefault()
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.UTILS.PREVENTED_APP_CLOSE)
      logMessage("info", "[back] [index] [main/index.ts] [createWindow] Main window prevented from closing.")
      return false
    }
    logMessage("info", "[back] [index] [main/index.ts] [createWindow] Main window closing.")
    return true
  })

  // HMR for renderer based on electron-vite CLI. Production uses a privileged app protocol instead of file://.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"])
  } else {
    mainWindow.loadURL("app://renderer/index.html")
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) app.quit()

/**
 * Reads electron-builder's `package-type` marker next to the packaged app, when the deb or
 * rpm targets wrote one. Its absence just means an AppImage, a flatpak, or a dev run, all of
 * which canAutoUpdate treats the same as "no marker".
 */
function readLinuxPackageType(): string | undefined {
  try {
    const markerPath = join(process.resourcesPath, "package-type")
    if (!fse.existsSync(markerPath)) return undefined
    return fse.readFileSync(markerPath, "utf-8").trim()
  } catch {
    return undefined
  }
}

// This method will be called when Electron has finished initialization and is ready to create browser windows. Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  logMessage("info", "[back] [index] [main/index.ts] [whenReady] Electron ready.")

  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  // webPreferences.spellcheck: false alone does not reliably stop Electron from fetching a
  // hunspell dictionary at startup (electron/electron#22995, electron/electron#24931).
  // setSpellCheckerEnabled(false) is the documented session-level toggle; clearing the
  // language list too covers the case where the dictionary fetch is driven by the OS
  // locale rather than by whether the checker itself is enabled.
  session.defaultSession.setSpellCheckerEnabled(false)
  session.defaultSession.setSpellCheckerLanguages([])

  if (!is.dev) {
    protocol.handle("app", async (request) => {
      try {
        const requestUrl = new URL(request.url)
        if (request.method !== "GET" || requestUrl.hostname !== "renderer" || requestUrl.username || requestUrl.password || requestUrl.port || requestUrl.search) {
          return new Response(null, { status: 400 })
        }

        const filePath = resolveContainedPath(packagedRendererRoot, requestUrl.pathname)
        if (!filePath || !(await isSafeProtocolFile(filePath))) return new Response(null, { status: 404 })
        return net.fetch(pathToFileURL(filePath).toString())
      } catch {
        return new Response(null, { status: 400 })
      }
    })
  }

  // Handler for mod icons
  protocol.handle("cachemodimg", async (req) => {
    const srcPath = join(app.getPath("userData"), "Cache", "Images", "Mods")
    const filePath = resolveContainedPath(srcPath, new URL(req.url).pathname)
    if (!filePath || !filePath.toLowerCase().endsWith(".png")) return new Response(null, { status: 404 })
    if (!(await isSafeProtocolFile(filePath))) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })

  // Handler for custom icons
  protocol.handle("icons", async (req) => {
    const srcPath = join(app.getPath("userData"), "Icons")
    const filePath = resolveContainedPath(srcPath, new URL(req.url).pathname)
    if (!filePath || !filePath.toLowerCase().endsWith(".png")) return new Response(null, { status: 404 })
    if (!(await isSafeProtocolFile(filePath))) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })

  await ensureConfig()

  // Set app user model id for windows
  electronApp.setAppUserModelId("net.stratumserver.riftlauncher")
  Menu.setApplicationMenu(null)

  // Default open or close DevTools by F12 in development and ignore CommandOrControl + R in production.
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  const updateDecision = canAutoUpdate({
    platform: process.platform,
    env: { UPDATE: process.env["UPDATE"], APPIMAGE: process.env["APPIMAGE"] },
    linuxPackageType: process.platform === "linux" ? readLinuxPackageType() : undefined
  })
  if (updateDecision.ok) {
    // If there is an update available send an event to the client.
    autoUpdater.on("update-available", () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATER.UPDATE_AVAILABLE)
    })

    // If there is an update downloaded send an event to the client.
    autoUpdater.on("update-downloaded", () => {
      markUpdateDownloaded()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATER.UPDATE_DOWNLOADED)
    })

    // Defer the network check until the initial window has had time to become interactive.
    const updateCheckTimer = setTimeout(() => {
      void autoUpdater.checkForUpdatesAndNotify()
    }, 5_000)
    updateCheckTimer.unref()
  } else {
    logMessage("info", `[back] [index] [main/index.ts] [whenReady] Auto-update disabled: ${updateDecision.reason}.`)
  }

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS.
app.on("window-all-closed", () => {
  if (getShouldPreventClose() && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.UTILS.PREVENTED_APP_CLOSE)
    return logMessage("info", "[back] [index] [main/index.ts] [window-all-closed] Main window prevented from closing.")
  }

  logMessage("info", "[back] [index] [main/index.ts] [window-all-closed] All windows closed.")
  if (process.platform !== "darwin") {
    app.quit()
  }
})

let isWaitingForConfigFlush = false

app.on("before-quit", (event) => {
  terminateActiveWorkers()

  if (isWaitingForConfigFlush) return
  const pendingConfigWrite = flushConfigWrites()
  if (pendingConfigWrite === null) return

  event.preventDefault()
  isWaitingForConfigFlush = true
  void pendingConfigWrite.then(
    () => app.quit(),
    () => app.quit()
  )
})

async function saveCurrentWindowState(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const { width, height, x, y } = mainWindow.getBounds()
  const maximized = mainWindow.isMaximized()

  const config = await getConfig()

  config.window = {
    width,
    height,
    x,
    y,
    maximized
  }

  saveConfig(config)
}

async function isSafeProtocolFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fse.lstat(filePath)
    if (!stats.isFile() || stats.isSymbolicLink()) return false
    const realPath = await fse.realpath(filePath)
    return realPath === filePath || (process.platform === "win32" && realPath.toLowerCase() === filePath.toLowerCase())
  } catch {
    return false
  }
}
