import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useGetInstalledMods } from "@renderer/features/mods/hooks/useGetInstalledMods"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { configSaveFailureMessageKey, initialConfigSaveHealthState, updateConfigSaveHealth } from "@renderer/features/config/utils/saveHealth"
import { CONFIG_ACTIONS, configReducer, initialState, type ConfigAction } from "@renderer/features/config/contexts/configReducer"

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
}

// Stable identity for the "nobody has been notified yet" case, so a consumer
// that only reads this slice does not see a new array on every unrelated
// render (see the "list slices are handed out as-is" note below).
const EMPTY_NOTIFIED_MOD_UPDATES: string[] = []

const ConfigDispatchContext = createContext<React.Dispatch<ConfigAction> | null>(null)
const InstallationsContext = createContext<InstallationType[] | null>(null)
const GameVersionsContext = createContext<GameVersionType[] | null>(null)
// The account is wrapped: `null` is a legitimate value (logged out), so it
// cannot double as the "no provider above me" sentinel the other contexts use.
const AccountContext = createContext<{ account: AccountType | null } | null>(null)
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

  useEffect(() => {
    ;(async (): Promise<void> => {
      window.api.utils.logMessage("info", `[front] [config] [features/config/contexts/ConfigCntext.tsx] [ConfigProvider] Setting context config from config file.`)
      const config = await window.api.configManager.getConfig()
      configDispatch({ type: CONFIG_ACTIONS.SET_CONFIG, payload: config })
    })()
  }, [])

  useEffect(() => {
    if (!isConfigLoaded && config.schemaVersion !== 0) setIsConfigLoaded(true)
    if (!isConfigLoaded) return

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

  useEffect(() => {
    const firstInstallation = config.installations[0]
    if ((!config.lastUsedInstallation || !config.installations.some((i) => i.id === config.lastUsedInstallation)) && firstInstallation)
      configDispatch({ type: CONFIG_ACTIONS.SET_LAST_USED_INSTALLATION, payload: firstInstallation.id })
  }, [config.installations])

  // The list slices are handed out as-is: the reducer never rebuilds an array
  // it did not change, so their identity already tracks their content. Only the
  // composed slices need memoising to stay stable across unrelated actions.
  const account = useMemo(() => ({ account: config.account }), [config.account])

  const settings = useMemo<ConfigSettingsType>(
    () => ({
      schemaVersion: config.schemaVersion,
      lastUsedInstallation: config.lastUsedInstallation,
      defaultInstallationsFolder: config.defaultInstallationsFolder,
      defaultVersionsFolder: config.defaultVersionsFolder,
      backupsFolder: config.backupsFolder,
      window: config.window
    }),
    [config.schemaVersion, config.lastUsedInstallation, config.defaultInstallationsFolder, config.defaultVersionsFolder, config.backupsFolder, config.window]
  )

  return (
    <ConfigDispatchContext.Provider value={configDispatch}>
      <NotifiedModUpdatesContext.Provider value={config._notifiedModUpdatesInstallations ?? EMPTY_NOTIFIED_MOD_UPDATES}>
        <SettingsContext.Provider value={settings}>
          <AccountContext.Provider value={account}>
            <InstallationsContext.Provider value={config.installations}>
              <GameVersionsContext.Provider value={config.gameVersions}>
                <FavModsContext.Provider value={config.favMods}>
                  <SuspendedModUpdatesContext.Provider value={config.suspendedModUpdates}>
                    <CustomIconsContext.Provider value={config.customIcons}>{children}</CustomIconsContext.Provider>
                  </SuspendedModUpdatesContext.Provider>
                </FavModsContext.Provider>
              </GameVersionsContext.Provider>
            </InstallationsContext.Provider>
          </AccountContext.Provider>
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

const useAccount = (): AccountType | null => requireProvider(useContext(AccountContext), "useAccount").account

/** Folders, window geometry, schema version and the last used installation. */
const useSettingsConfig = (): ConfigSettingsType => requireProvider(useContext(SettingsContext), "useSettingsConfig")

const useFavMods = (): number[] => requireProvider(useContext(FavModsContext), "useFavMods")

/** Modids the player holds back from Update All. Their update notices are unaffected. */
const useSuspendedModUpdates = (): string[] => requireProvider(useContext(SuspendedModUpdatesContext), "useSuspendedModUpdates")

const useCustomIcons = (): IconType[] => requireProvider(useContext(CustomIconsContext), "useCustomIcons")

/** Ids of installations the player has already been told about mod updates for, this session. */
const useNotifiedModUpdates = (): string[] => requireProvider(useContext(NotifiedModUpdatesContext), "useNotifiedModUpdates")

export { ConfigProvider, useConfigDispatch, useInstallations, useGameVersions, useAccount, useSettingsConfig, useFavMods, useSuspendedModUpdates, useCustomIcons, useNotifiedModUpdates }
