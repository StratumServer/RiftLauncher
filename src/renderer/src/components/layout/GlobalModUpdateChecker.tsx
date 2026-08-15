import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { useConfigContext } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useGetCompleteInstalledMods } from "@renderer/features/mods/hooks/useGetCompleteInstalledMods"

function GlobalModUpdateChecker(): null {
  const { t } = useTranslation()
  const { config } = useConfigContext()
  const { addNotification } = useNotificationsContext()
  const goTo = useNavigate()
  const getCompleteInstalledMods = useGetCompleteInstalledMods()

  useEffect(() => {
    const lastUsedInstallation = config.lastUsedInstallation ? config.installations.find((installation) => installation.id === config.lastUsedInstallation) : undefined
    if (!lastUsedInstallation) return

    getCompleteInstalledMods({
      path: lastUsedInstallation.path,
      version: lastUsedInstallation.version,
      onFinish: (updates) => {
        if (config._notifiedModUpdatesInstallations === undefined || config._notifiedModUpdatesInstallations.length === 0) config._notifiedModUpdatesInstallations = []
        if (updates > 0 && !config._notifiedModUpdatesInstallations.some((installationId) => installationId === lastUsedInstallation.id)) {
          config._notifiedModUpdatesInstallations.push(lastUsedInstallation.id)
          window.setTimeout(() => {
            addNotification(t("features.mods.updatesAvailableInstallation", { count: updates }), "info", {
              onClick: () => goTo(`/installations/mods/${lastUsedInstallation.id}`)
            })
          }, 2_000)
        }
      }
    })
  }, [config.lastUsedInstallation])

  return null
}

export default GlobalModUpdateChecker
