import { useEffect } from "react"
import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { onPreventedAppClose } from "@renderer/features/launch/adapters/launch"

/** Subscribes for the app's lifetime to "your close attempt was prevented" and toasts it. */
export function useNotifyOnPreventedAppClose(): void {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  useEffect(() => {
    return onPreventedAppClose(() => addNotification(t("notifications.body.appClosePrevented"), "warning"))
  }, [])
}
