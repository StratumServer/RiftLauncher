import { app, shell, BrowserWindow, protocol, net, session, Menu, ipcMain } from "electron"
import { dirname, join } from "node:path"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"
import { autoUpdater } from "electron-updater"
import Logger from "electron-log"
import { pathToFileURL } from "node:url"
import { describeUserDataSetup, setUpUserDataFolder } from "@src/main/userDataMigration"

const userDataSetup = setUpUserDataFolder(app.getPath("appData"))
app.setPath("userData", userDataSetup.path)

import { ensureConfig, flushConfigWrites, getConfig, saveConfig } from "@src/config/configManager"
import { getShouldPreventClose } from "@src/utils/shouldPreventClose"
import icon from "../../resources/icon.png?asset"
import { logMessage } from "@src/utils/logManager"
import { createUpdaterLogger } from "@src/utils/updaterLogger"
import { createSuppressedErrorRecorder, makeConsoleOutputFaultTolerant } from "@src/utils/consoleTransportSafety"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { isTrustedIpcSender, registerTrustedWebContents } from "@src/ipc/ipcSecurity"
import { assertAllowedBrowserUrl, isAllowedRendererUrl, resolveContainedPath } from "@src/ipc/validation"
import { terminateActiveWorkers } from "@src/ipc/workerManager"
import { registerAutoUpdaterEvents, scheduleUpdateCheck } from "@src/main/autoUpdaterEvents"
import { canAutoUpdate } from "@domain/appUpdate/canAutoUpdate"
import { resolveAllowPrerelease } from "@domain/appUpdate/betaUpdates"
import { pruneModIconCache } from "@src/ipc/adapters/modScan"
import { IconMemoryCache } from "@domain/mods/iconMemoryCache"
import { createBackgroundProtocolHandler, createCacheModImageProtocolHandler, isSafeProtocolFile } from "@src/main/protocolFiles"
import { clearModIconMemoryCache, createClearModIconMemoryCacheHandler } from "@src/main/modIconMemoryCacheLifecycle"
import fse from "fs-extra"

import "@src/ipc"
import { clearTimeout, setTimeout } from "node:timers"

// #247: when the terminal that started the launcher exits, the next console write fails, and
// Node reports that failure as an "error" event on process.stdout with no listener, i.e. an
// uncaught exception Electron shows as "A JavaScript error occurred in the main process".
// Placed before resolvePathFn rather than after it, unlike autoUpdater.logger below: this
// guard touches no path and writes no file, so it has nothing to wait for, and running it
// first means it is already in place for the very first line logged below.
// #256: the guard swallows every console failure, so the first one leaves a line in the log
// file, otherwise an ordinary transport bug would be indistinguishable from silence. Handing it
// the file transport rather than Logger.error keeps the record off the console that just failed.
// The whole logger goes in rather than just its console transport: a format or transform failure
// is reported through Logger.processInternalErrorFn instead of the write, and that seam needs the
// same recorder for the failure to leave a trace.
makeConsoleOutputFaultTolerant(Logger, undefined, createSuppressedErrorRecorder(Logger.transports.file))

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
const modIconMemoryCache = new IconMemoryCache()
const packagedRendererPath = join(__dirname, "../renderer/index.html")
const packagedRendererRoot = dirname(packagedRendererPath)

ipcMain.on(IPC_CHANNELS.MODS_MANAGER.CLEAR_MOD_ICON_MEMORY_CACHE, createClearModIconMemoryCacheHandler(modIconMemoryCache, isTrustedIpcSender))

// One call, whatever the build: registerSchemesAsPrivileged replaces the list rather than adding
// to it, so a second call would take the app scheme back out.
const privilegedSchemes: Electron.CustomScheme[] = [
  {
    // Not `standard`, on purpose. The handler reads the file name straight off
    // `new URL(request.url).pathname`, the shape a non-standard scheme gives it and the same one
    // cachemodimg: and icons: rely on; making it standard would turn `background:scene.jpg` into
    // a host and change that parse.
    scheme: "background",
    privileges: {
      secure: true
    }
  }
]

if (!is.dev) {
  privilegedSchemes.push({
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true
    }
  })
}

protocol.registerSchemesAsPrivileged(privilegedSchemes)

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
      // This flag alone does not stop that download. The call that stops it is
      // setSpellCheckerLanguages([]) in the whenReady handler below, which empties the
      // session's language list so there is no dictionary left to fetch.
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
 * Reads electron-builder's `package-type` marker next to the packaged app, when the deb,
 * rpm or pacman targets wrote one. Its absence just means an AppImage, a flatpak, or a dev
 * run, all of which canAutoUpdate treats the same as "no marker".
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
  // webPreferences.spellcheck: false alone does not stop Electron from fetching a
  // hunspell dictionary at startup (electron/electron#22995, electron/electron#24931).
  // setSpellCheckerLanguages([]) is the call that stops it: the fetch follows the session's
  // language list, so an empty list leaves nothing to download. That is the whole fix, not
  // an edge case on top of the toggle below it. A fresh profile with spellcheck: false and
  // setSpellCheckerEnabled(false) set, language list untouched, downloaded the dictionary
  // anyway, reproduced twice (#132). setSpellCheckerEnabled(false) stays as the documented
  // session-level toggle, but it is the redundant half of the pair. Tidying away the
  // language list line brings the download back, and tests/security-boundaries.test.ts
  // now fails if either call goes missing.
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

  // Handler for mod icons. A name in this folder is written once and never rewritten (a sha256 of
  // the bytes for an archive icon, a sha256 of the URL for a ModDB logo), so a hit in
  // modIconMemoryCache can never serve stale bytes.
  protocol.handle(
    "cachemodimg",
    createCacheModImageProtocolHandler({
      cache: modIconMemoryCache,
      getUserDataPath: () => app.getPath("userData"),
      fetchFile: (url) => net.fetch(url)
    })
  )

  // Handler for the chosen launcher background, downloaded or supplied by the player.
  protocol.handle(
    "background",
    createBackgroundProtocolHandler({
      getUserDataPath: () => app.getPath("userData"),
      fetchFile: (url) => net.fetch(url)
    })
  )

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

  // Fire and forget, after the window exists so it stays off the first paint path
  // and before the renderer's first scan 2.5 seconds later. This is the only
  // sweep of the shared mod icon cache: a scan reads one installation and the
  // folder holds every installation's icons, so a scan can never decide what is
  // dead there (#117).
  void pruneModIconCache()

  const updateDecision = canAutoUpdate({
    platform: process.platform,
    env: { UPDATE: process.env["UPDATE"], APPIMAGE: process.env["APPIMAGE"] },
    linuxPackageType: process.platform === "linux" ? readLinuxPackageType() : undefined
  })
  if (updateDecision.ok) {
    registerAutoUpdaterEvents((channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    })

    // Who gets offered a beta, said out loud rather than left to electron-updater, which reads it
    // off the running version alone: that leaves someone on a stable build with no way to ask for
    // betas, and someone who tried one beta signed up for every beta after it. The stored answer
    // wins when there is one, and the running version still decides when there is not. Read inside
    // the callback, so the answer the check uses is the one the settings page has stored by then
    // rather than the one it had at launch.
    scheduleUpdateCheck(async () => resolveAllowPrerelease((await getConfig()).receiveBetaUpdates, app.getVersion()))
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
  clearModIconMemoryCache(modIconMemoryCache)
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
