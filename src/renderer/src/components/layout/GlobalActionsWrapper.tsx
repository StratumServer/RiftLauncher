import { ReactNode, useEffect } from "react"
import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

/**
 * This is a little workaround to execute hooks that need to acces configs, notifications... but need to be execute globally and not
 * when opening a page or something.
 *
 * Maybe there are better options but this one is clean, easy to unserstand and read... is perfect!
 *
 * @param {Object} props
 * @param {ReactNode} [props.children] All the content to be rendered.
 * @returns {JSX.Element} Wrapper with NOTHING. Literally nothing. Just children. return <>{children}</>
 */
function GlobalActionsWrapper({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  useEffect(() => {
    const removePreventedAppCloseListener = window.api.utils.onPreventedAppClose(() => addNotification(t("notifications.body.appClosePrevented"), "warning"))
    return removePreventedAppCloseListener
  }, [])

  return <>{children}</>
}

export default GlobalActionsWrapper
