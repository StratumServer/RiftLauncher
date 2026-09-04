import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { CONFIG_ACTIONS, useConfigDispatch, useInstallations, useSettingsConfig, useNotifiedModUpdates } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useGetCompleteInstalledMods } from "@renderer/features/mods/hooks/useGetCompleteInstalledMods"

function GlobalModUpdateChecker(): null {
  const { t } = useTranslation()
  const installations = useInstallations()
  const { lastUsedInstallation: lastUsedInstallationId } = useSettingsConfig()
  const notifiedInstallations = useNotifiedModUpdates()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()
  const goTo = useNavigate()
  const getCompleteInstalledMods = useGetCompleteInstalledMods()

  useEffect(() => {
    const lastUsedInstallation = lastUsedInstallationId ? installations.find((installation) => installation.id === lastUsedInstallationId) : undefined
    if (!lastUsedInstallation) return

    getCompleteInstalledMods({
      path: lastUsedInstallation.path,
      version: lastUsedInstallation.version,
      onFinish: (updates) => {
        if (updates > 0 && !notifiedInstallations.includes(lastUsedInstallation.id)) {
          configDispatch({ type: CONFIG_ACTIONS.ADD_NOTIFIED_MOD_UPDATE, payload: { installationId: lastUsedInstallation.id } })
          window.setTimeout(() => {
            addNotification(t("features.mods.updatesAvailableInstallation", { count: updates }), "info", {
              actions: [
                {
                  id: "view-updates",
                  label: t("components.activityCenter.viewUpdates"),
                  onClick: (): void => {
                    void goTo(`/installations/mods/${lastUsedInstallation.id}`)
                  }
                }
              ]
            })
          }, 2_000)
        }
      }
    })
  }, [lastUsedInstallationId])

  return null
}

export default GlobalModUpdateChecker
