import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { useInstallations, useSettingsConfig, useModUpdateNotices } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useGetCompleteInstalledMods } from "@renderer/features/mods/hooks/useGetCompleteInstalledMods"

function GlobalModUpdateChecker(): null {
  const { t } = useTranslation()
  const installations = useInstallations()
  const { lastUsedInstallation: lastUsedInstallationId } = useSettingsConfig()
  const { notifiedInstallations } = useModUpdateNotices()
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
        const notified = notifiedInstallations()
        if (updates > 0 && !notified.some((installationId) => installationId === lastUsedInstallation.id)) {
          notified.push(lastUsedInstallation.id)
          window.setTimeout(() => {
            addNotification(t("features.mods.updatesAvailableInstallation", { count: updates }), "info", {
              onClick: () => goTo(`/installations/mods/${lastUsedInstallation.id}`)
            })
          }, 2_000)
        }
      }
    })
  }, [lastUsedInstallationId])

  return null
}

export default GlobalModUpdateChecker
