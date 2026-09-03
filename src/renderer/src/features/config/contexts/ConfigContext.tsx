import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useGetInstalledMods } from "@renderer/features/mods/hooks/useGetInstalledMods"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { configSaveFailureMessageKey, initialConfigSaveHealthState, updateConfigSaveHealth } from "@renderer/features/config/utils/saveHealth"
import { CONFIG_ACTIONS, configReducer, initialState, type ConfigAction } from "@renderer/features/config/contexts/configReducer"
import { applyBackground } from "@renderer/utils/backgroundStyle"
import { CURRENT_CONFIG_SCHEMA } from "@domain/config/migrations"

// Re-exported so a consumer needs one import to read a slice and dispatch onto it.
export { CONFIG_ACTIONS } from "@renderer/features/config/contexts/configReducer"
export type { ConfigAction } from "@renderer/features/config/contexts/configReducer"

/** Everything in the config that is neither a domain list nor the account. */
export interface ConfigSettingsType {
  schemaVersion: number
  lastUsedInstallation: string | null
  defaultInstallationsFolder: string
  defaultVersionsFolder: string
  backupsFolder: string
  window: WindowType
  background: string
  /** Changes on every background selection, so a replaced custom picture still repaints. */
  backgroundRevision: number
  /** The stored answer to the one-time ModDB listing question. See src/domain/moddbVisibility.ts. */
  moddbVisibilityAnswer: string
  /** Whether update checks may offer betas, or null while nobody has said. See src/domain/appUpdate/betaUpdates.ts. */
  receiveBetaUpdates: boolean | null
}

// Stable identity for the "nobody has been notified yet" case, so a consumer
// that only reads this slice does not see a new array on every unrelated
// render (see the "list slices are handed out as-is" note below).
const EMPTY_NOTIFIED_MOD_UPDATES: string[] = []

const ConfigDispatchContext = createContext<React.Dispatch<ConfigAction> | null>(null)
const InstallationsContext = createContext<InstallationType[] | null>(null)
const GameVersionsContext = createContext<GameVersionType[] | null>(null)
// Wrapped: activeAccountId is legitimately null with a non-empty list, so the wrapper (not the
// field) is what tells a missing provider apart from a real logged-out state.
const AccountListContext = createContext<{ accounts: AccountPublicType[]; activeAccountId: string | null } | null>(null)
const SettingsContext = createContext<ConfigSettingsType | null>(null)
const FavModsContext = createContext<number[] | null>(null)
const SuspendedModUpdatesContext = createContext<string[] | null>(null)
const CustomIconsContext = createContext<IconType[] | null>(null)
const NotifiedModUpdatesContext = createContext<string[] | null>(null)

const ConfigProvider = ({ children }: { children: React.ReactNode }): JSX.Element => {
  const [config, configDispatch] = useReducer(configReducer, initialState)
  const [isConfigLoaded, setIsConfigLoaded] = useState(false)

  const getInstalledMods = useGetInstalledMods()
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  // Carries the running failure streak across renders without re-triggering
  // this effect: only the save result should decide when to notify, never a
  // state update reacting to its own state update.
  const saveHealthRef = useRef(initialConfigSaveHealthState)
  // Set when the config read failed, and never cleared. What the provider holds from then on is
  // the reducer's defaults rather than anything a player chose, and the save effect below reads
  // this to keep those defaults off disk.
  const configReadFailedRef = useRef(false)

  useEffect(() => {
    ;(async (): Promise<void> => {
      window.api.utils.logMessage("info", `[front] [config] [features/config/contexts/ConfigCntext.tsx] [ConfigProvider] Setting context config from config file.`)
      try {
        const config = await window.api.configManager.getConfig()
        configDispatch({ type: CONFIG_ACTIONS.SET_CONFIG, payload: config })
      } catch (error) {
        // The splash (see App.tsx's Loader) only comes down once schemaVersion !== 0, so a
        // rejection left uncaught here would keep it up for the rest of the session, where the
        // fixed-timer splash this replaced always lifted regardless of whether the read behind
        // it had succeeded. Dispatching the reducer's own initial config, stamped with a real
        // schema version instead of the 0 sentinel it starts life with, lets the app come up in
        // a usable state instead of a permanently stuck launch. What is on disk stays there:
        // these defaults describe nobody's launcher, so the save effect below refuses to write
        // anything for the rest of a session that started this way.
        window.api.utils.logMessage("error", `[front] [config] [features/config/contexts/ConfigContext.tsx] [ConfigProvider] Error reading the config file.`)
        window.api.utils.logMessage("debug", `[front] [config] [features/config/contexts/ConfigContext.tsx] [ConfigProvider] getConfig rejected: ${error}.`)
        configReadFailedRef.current = true
        configDispatch({ type: CONFIG_ACTIONS.SET_CONFIG, payload: { ...initialState, schemaVersion: CURRENT_CONFIG_SCHEMA } })
      }
    })()
  }, [])

  useEffect(() => {
    if (!isConfigLoaded && config.schemaVersion !== 0) setIsConfigLoaded(true)
    if (!isConfigLoaded) return
    // A session that could not read the config is running on invented defaults: no installations,
    // no accounts, none of the player's preferences. Saving that would replace a config this
    // process never managed to see, so this session stays read-only and a later launch that can
    // read the file again finds it exactly as the player left it.
    if (configReadFailedRef.current) return

    // Still fire-and-forget in spirit: nothing here blocks the UI on a save.
    // The result is only observed to decide whether the player needs telling.
    void window.api.configManager.saveConfig(config).then((result) => {
      const { state, notice } = updateConfigSaveHealth(saveHealthRef.current, result)
      saveHealthRef.current = state
      if (!notice) return

      if (notice.kind === "failing") {
        window.api.utils.logMessage("error", `[front] [config] [features/config/contexts/ConfigContext.tsx] [ConfigProvider] Config saves are failing: ${notice.reason}.`)
        addNotification(t(configSaveFailureMessageKey(notice.reason)), "error")
      } else {
        addNotification(t("notifications.body.configSaveRecovered"), "success")
      }
    })
  }, [config])

  useEffect(() => {
    if (!isConfigLoaded) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        for (const installation of config.installations) {
          if (cancelled) return
          const mods = await getInstalledMods({ path: installation.path })
          if (cancelled) return
          const totalMods = mods.errors.length + mods.mods.length
          configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { _modsCount: totalMods } } })
        }
      })()
    }, 2_500)

    return (): void => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [isConfigLoaded])

  // Paints the stored choice. Reads nothing but the config, so a launch with no network shows the
  // chosen scene straight from the cache, or the bundled one when that file is not there.
  useEffect(() => {
    applyBackground(config.background, config._backgroundRevision ?? 0)
  }, [config.background, config._backgroundRevision])

  useEffect(() => {
    const firstInstallation = config.installations[0]
    if ((!config.lastUsedInstallation || !config.installations.some((i) => i.id === config.lastUsedInstallation)) && firstInstallation)
      configDispatch({ type: CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION, payload: firstInstallation.id })
  }, [config.installations])

  // The list slices are handed out as-is: the reducer never rebuilds an array
  // it did not change, so their identity already tracks their content. Only the
  // composed slices need memoising to stay stable across unrelated actions.
  const accountList = useMemo(() => ({ accounts: config.accounts, activeAccountId: config.activeAccountId }), [config.accounts, config.activeAccountId])

  const settings = useMemo<ConfigSettingsType>(
    () => ({
      schemaVersion: config.schemaVersion,
      lastUsedInstallation: config.lastUsedInstallation,
      defaultInstallationsFolder: config.defaultInstallationsFolder,
      defaultVersionsFolder: config.defaultVersionsFolder,
      backupsFolder: config.backupsFolder,
      window: config.window,
      background: config.background,
      backgroundRevision: config._backgroundRevision ?? 0,
      moddbVisibilityAnswer: config.moddbVisibilityAnswer,
      receiveBetaUpdates: config.receiveBetaUpdates
    }),
    [
      config.schemaVersion,
      config.lastUsedInstallation,
      config.defaultInstallationsFolder,
      config.defaultVersionsFolder,
      config.backupsFolder,
      config.window,
      config.background,
      config._backgroundRevision,
      config.moddbVisibilityAnswer,
      config.receiveBetaUpdates
    ]
  )

  return (
    <ConfigDispatchContext.Provider value={configDispatch}>
      <NotifiedModUpdatesContext.Provider value={config._notifiedModUpdatesInstallations ?? EMPTY_NOTIFIED_MOD_UPDATES}>
        <SettingsContext.Provider value={settings}>
          <AccountListContext.Provider value={accountList}>
            <InstallationsContext.Provider value={config.installations}>
              <GameVersionsContext.Provider value={config.gameVersions}>
                <FavModsContext.Provider value={config.favMods}>
                  <SuspendedModUpdatesContext.Provider value={config.suspendedModUpdates}>
                    <CustomIconsContext.Provider value={config.customIcons}>{children}</CustomIconsContext.Provider>
                  </SuspendedModUpdatesContext.Provider>
                </FavModsContext.Provider>
              </GameVersionsContext.Provider>
            </InstallationsContext.Provider>
          </AccountListContext.Provider>
        </SettingsContext.Provider>
      </NotifiedModUpdatesContext.Provider>
    </ConfigDispatchContext.Provider>
  )
}

function requireProvider<T>(value: T | null, hook: string): T {
  if (value === null) throw new Error(`${hook} must be used within a ConfigProvider`)
  return value
}

/** Writes. Stable for the life of the provider, so subscribing to it never costs a render. */
const useConfigDispatch = (): React.Dispatch<ConfigAction> => requireProvider(useContext(ConfigDispatchContext), "useConfigDispatch")

const useInstallations = (): InstallationType[] => requireProvider(useContext(InstallationsContext), "useInstallations")

const useGameVersions = (): GameVersionType[] => requireProvider(useContext(GameVersionsContext), "useGameVersions")

/** Every saved account, and which one is active. */
const useAccountList = (): { accounts: AccountPublicType[]; activeAccountId: string | null } => requireProvider(useContext(AccountListContext), "useAccountList")

/** Folders, window geometry, schema version and the last used installation. */
const useSettingsConfig = (): ConfigSettingsType => requireProvider(useContext(SettingsContext), "useSettingsConfig")

const useFavMods = (): number[] => requireProvider(useContext(FavModsContext), "useFavMods")

/** Modids the player holds back from Update All. Their update notices are unaffected. */
const useSuspendedModUpdates = (): string[] => requireProvider(useContext(SuspendedModUpdatesContext), "useSuspendedModUpdates")

const useCustomIcons = (): IconType[] => requireProvider(useContext(CustomIconsContext), "useCustomIcons")

/** Ids of installations the player has already been told about mod updates for, this session. */
const useNotifiedModUpdates = (): string[] => requireProvider(useContext(NotifiedModUpdatesContext), "useNotifiedModUpdates")

export { ConfigProvider, useConfigDispatch, useInstallations, useGameVersions, useAccountList, useSettingsConfig, useFavMods, useSuspendedModUpdates, useCustomIcons, useNotifiedModUpdates }
