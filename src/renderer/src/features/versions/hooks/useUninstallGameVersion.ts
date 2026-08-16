import { useTranslation } from "react-i18next"

import { uninstallGameVersion } from "@domain/versions/uninstall"
import type { UninstallGameVersionResult } from "@domain/versions/uninstall"
import { useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { createUninstallPorts, describeUninstallFailure, toGameVersionSnapshot } from "@renderer/features/versions/adapters/uninstall"

const LOG_TAG = "[front] [versions] [features/versions/hooks/useUninstallGameVersion.ts] [useUninstallGameVersion > uninstallVersion]"

export interface UninstallGameVersionOptions {
  /** Names of the installations still pointing at this version, for the in-use warning. */
  usedByInstallations?: readonly string[]
  /** Whether the caller already showed the in-use warning and got a yes. */
  confirmedInUse?: boolean
}

/**
 * Runs ListVersions' delete flow against one game version, config updates and
 * notification included. Returns the domain result so the caller can react to
 * a `version-in-use` refusal (show a second confirm) without this hook
 * treating it like a hard failure.
 */
export function useUninstallGameVersion(): (version: GameVersionType, options?: UninstallGameVersionOptions) => Promise<UninstallGameVersionResult> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const configDispatch = useConfigDispatch()

  return async function uninstallVersion(version, options = {}) {
    const { usedByInstallations = [], confirmedInUse = false } = options

    const result = await uninstallGameVersion(
      createUninstallPorts(),
      { version: toGameVersionSnapshot(version), usedByInstallations, confirmedInUse },
      {
        onStarted: () => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: version.version, updates: { _deleting: true } } }),
        onFinished: () => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: version.version, updates: { _deleting: false } } })
      }
    )

    if (result.ok) {
      configDispatch({ type: CONFIG_ACTIONS.DELETE_GAME_VERSION, payload: { version: version.version } })
      addNotification(t("features.versions.versionUninstalledSuccesfully", { version: version.version }), "success")
      return result
    }

    // The caller (ListVersions) is expected to show its own delete-anyway
    // warning for this reason instead of a plain notification.
    if (result.reason === "version-in-use") return result

    const { messageKey, logged } = describeUninstallFailure(result.reason)

    if (logged) {
      window.api.utils.logMessage("error", `${LOG_TAG} Error uninstalling a VS Version.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Error uninstalling VS Version ${version.version}: ${result.reason}.`)
    }

    addNotification(t(messageKey, { version: version.version }), "error")
    return result
  }
}
