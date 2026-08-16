import { useTranslation } from "react-i18next"

import { uninstallGameVersion } from "@domain/versions/uninstall"
import { useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { createUninstallPorts, describeUninstallFailure, toGameVersionSnapshot } from "@renderer/features/versions/adapters/uninstall"

const LOG_TAG = "[front] [versions] [features/versions/hooks/useUninstallGameVersion.ts] [useUninstallGameVersion > uninstallVersion]"

/** Runs ListVersions' delete flow against one game version, config updates and notification included. */
export function useUninstallGameVersion(): (version: GameVersionType) => Promise<void> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const configDispatch = useConfigDispatch()

  return async function uninstallVersion(version) {
    const result = await uninstallGameVersion(
      createUninstallPorts(),
      { version: toGameVersionSnapshot(version) },
      {
        onStarted: () => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: version.version, updates: { _deleting: true } } }),
        onFinished: () => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: version.version, updates: { _deleting: false } } })
      }
    )

    if (result.ok) {
      configDispatch({ type: CONFIG_ACTIONS.DELETE_GAME_VERSION, payload: { version: version.version } })
      addNotification(t("features.versions.versionUninstalledSuccesfully", { version: version.version }), "success")
      return
    }

    const { messageKey, logged } = describeUninstallFailure(result.reason)

    if (logged) {
      window.api.utils.logMessage("error", `${LOG_TAG} Error uninstalling a VS Version.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Error uninstalling VS Version ${version.version}: ${result.reason}.`)
    }

    addNotification(t(messageKey, { version: version.version }), "error")
  }
}
