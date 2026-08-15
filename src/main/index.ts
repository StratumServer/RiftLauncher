import { app, shell, BrowserWindow, protocol, net, session, Menu } from "electron"
import { dirname, join } from "path"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"
import { autoUpdater } from "electron-updater"
import Logger from "electron-log"
import { pathToFileURL } from "url"

const customUserDataPath = join(app.getPath("appData"), "VSLauncher")
app.setPath("userData", customUserDataPath)

import { ensureConfig, flushConfigWrites, getConfig, saveConfig } from "@src/config/configManager"
import { getShouldPreventClose } from "@src/utils/shouldPreventClose"
import icon from "../../resources/icon.png?asset"
import { logMessage } from "@src/utils/logManager"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { registerTrustedWebContents } from "@src/ipc/ipcSecurity"
import { assertAllowedBrowserUrl, isAllowedRendererUrl, resolveContainedPath } from "@src/ipc/validation"
import { terminateActiveWorkers } from "@src/ipc/workerManager"
import { markUpdateDownloaded } from "@src/ipc/handlers/appUpdaterHandlers"
import fse from "fs-extra"

import "@src/ipc"
import { clearTimeout, setTimeout } from "timers"

autoUpdater.logger = Logger
autoUpdater.logger.info("Logger configured for auto-updater")

Logger.transports.file.resolvePathFn = (variables, message): string => {
  const logsPath = join(variables.userData, "Logs")
  if (!message) return join(logsPath, "default.log")
  return join(logsPath, `${message.level}.log`)
}

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
    title: `VS Launcher - ${app.getVersion()}`,
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

// This method will be called when Electron has finished initialization and is ready to create browser windows. Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  logMessage("info", "[back] [index] [main/index.ts] [whenReady] Electron ready.")

  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

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
  electronApp.setAppUserModelId("xyz.xurxomf")
  Menu.setApplicationMenu(null)

  // Default open or close DevTools by F12 in development and ignore CommandOrControl + R in production.
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  if (process.env["UPDATE"] !== "false") {
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
  if (!pendingConfigWrite) return

  event.preventDefault()
  isWaitingForConfigFlush = true
  void pendingConfigWrite.then(
    () => app.quit(),
    () => app.quit()
  )
})

async function saveCurrentWindowState(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const { width, height } = mainWindow.getBounds()
  const [x, y] = mainWindow.getPosition()
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
