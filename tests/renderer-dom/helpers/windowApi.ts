import { vi } from "vitest"

/**
 * A window.api mock for mounting real components under jsdom.
 *
 * Every method is typed against the preload's BridgeAPI (src/preload/preload.d.ts)
 * so a signature change there breaks this file, not a test silently drifting out
 * of sync with the real bridge.
 *
 * Reads (getConfig, checkPathExists, getInstalledMods, ...) default to boring,
 * safe values so a component can mount without a test having to think about
 * every channel it happens to call. Actions that would do something if they
 * were real (delete, move, download, extract, login, ...) default to a
 * rejection naming the call: mounting a component should never look like it
 * silently deleted a file or logged someone in. Override the specific method
 * on the object this factory returns for whatever the test actually exercises.
 */

export type MockedBridgeAPI = { [K in keyof BridgeAPI]: { [M in keyof BridgeAPI[K]]: BridgeAPI[K][M] } }
export type WindowApiOverrides = { [K in keyof BridgeAPI]?: Partial<BridgeAPI[K]> }

function notMocked(channel: string): () => Promise<never> {
  return () => Promise.reject(new Error(`window.api.${channel} was called without a mock override in this test.`))
}

function noopUnsubscribe(): Unsubscribe {
  return () => {}
}

/** A ConfigType with every field present and empty/zeroed, ready to spread overrides onto. */
export function createMockConfig(overrides: Partial<ConfigType> = {}): ConfigType {
  return {
    schemaVersion: 1,
    lastUsedInstallation: null,
    defaultInstallationsFolder: "",
    defaultVersionsFolder: "",
    backupsFolder: "",
    window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
    account: null,
    installations: [],
    gameVersions: [],
    favMods: [],
    suspendedModUpdates: [],
    background: "default",
    moddbVisibilityAnswer: "unasked",
    receiveBetaUpdates: null,
    customIcons: [],
    ...overrides
  }
}

/**
 * Builds a fresh `window.api` mock. Every leaf is a `vi.fn`, so
 * `vi.mocked(api.configManager.saveConfig).mockResolvedValueOnce(...)` and
 * friends work directly on the returned object.
 *
 * `overrides` replaces individual methods per namespace; it does not need to
 * supply a whole namespace.
 */
export function createMockWindowApi(overrides: WindowApiOverrides = {}): MockedBridgeAPI {
  const base: MockedBridgeAPI = {
    utils: {
      getAppVersion: vi.fn(async () => "0.0.0"),
      getOs: vi.fn(async () => "linux" as NodeJS.Platform),
      logMessage: vi.fn(),
      setPreventAppClose: vi.fn(),
      openOnBrowser: vi.fn(),
      selectFolderDialog: vi.fn(async () => []),
      onPreventedAppClose: vi.fn(noopUnsubscribe)
    },
    appUpdater: {
      onUpdateAvailable: vi.fn(noopUnsubscribe),
      onUpdateDownloadProgress: vi.fn(noopUnsubscribe),
      onUpdateError: vi.fn(noopUnsubscribe),
      onUpdateDownloaded: vi.fn(noopUnsubscribe),
      downloadUpdate: vi.fn(),
      updateAndRestart: vi.fn()
    },
    configManager: {
      getConfig: vi.fn(async () => createMockConfig()),
      saveConfig: vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    },
    modsManager: {
      getInstalledMods: vi.fn(async () => ({ mods: [], errors: [] })),
      exportModpack: vi.fn(notMocked("modsManager.exportModpack")),
      importModpack: vi.fn(notMocked("modsManager.importModpack")),
      clearModIconMemoryCache: vi.fn()
    },
    pathsManager: {
      getCurrentUserDataPath: vi.fn(async () => "/mock/userdata"),
      formatPath: vi.fn(async (parts: string[]) => parts.join("/")),
      removeFileFromPath: vi.fn(async (path: string) => path),
      deletePath: vi.fn(notMocked("pathsManager.deletePath")),
      movePath: vi.fn(notMocked("pathsManager.movePath")),
      checkPathEmpty: vi.fn(async () => true),
      checkPathExists: vi.fn(async () => false),
      ensurePathExists: vi.fn(async () => true),
      openPathOnFileExplorer: vi.fn(async () => {}),
      downloadOnPath: vi.fn(notMocked("pathsManager.downloadOnPath")),
      extractOnPath: vi.fn(notMocked("pathsManager.extractOnPath")),
      runInstaller: vi.fn(notMocked("pathsManager.runInstaller")),
      compressOnPath: vi.fn(notMocked("pathsManager.compressOnPath")),
      onDownloadProgress: vi.fn(noopUnsubscribe),
      onExtractProgress: vi.fn(noopUnsubscribe),
      onCompressProgress: vi.fn(noopUnsubscribe),
      changePerms: vi.fn(notMocked("pathsManager.changePerms")),
      copyToIcons: vi.fn(notMocked("pathsManager.copyToIcons"))
    },
    gameManager: {
      executeGame: vi.fn(notMocked("gameManager.executeGame")),
      lookForAGameVersion: vi.fn(async () => ({ exists: false as const }))
    },
    netManager: {
      queryURL: vi.fn(notMocked("netManager.queryURL")),
      acceptModDbVisibility: vi.fn(notMocked("netManager.acceptModDbVisibility"))
    },
    backgroundsManager: {
      ensureBackground: vi.fn(notMocked("backgroundsManager.ensureBackground")),
      copyCustomBackground: vi.fn(notMocked("backgroundsManager.copyCustomBackground"))
    },
    accountManager: {
      login: vi.fn(notMocked("accountManager.login")),
      logout: vi.fn(notMocked("accountManager.logout"))
    }
  }

  for (const namespace of Object.keys(overrides) as (keyof BridgeAPI)[]) {
    Object.assign(base[namespace], overrides[namespace])
  }

  return base
}

/** Installs a fresh mock on `window.api` and returns it. Call again per test to reset. */
export function installMockWindowApi(overrides: WindowApiOverrides = {}): MockedBridgeAPI {
  const api = createMockWindowApi(overrides)
  Object.defineProperty(window, "api", { value: api, writable: true, configurable: true })
  return api
}
