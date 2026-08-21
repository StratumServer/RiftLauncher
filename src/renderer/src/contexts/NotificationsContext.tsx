import { createContext, useState, useEffect, useContext } from "react"
import { useTranslation } from "react-i18next"
import { v4 as uuidv4 } from "uuid"

import { launcherUpdateName } from "@renderer/utils/launcherUpdateTask"

type NotificationTypes = "success" | "error" | "info" | "warning"

/**
 * A labelled button rendered inside the toast. Whatever it does, clicking it
 * also dismisses the notification, so a choice can only be answered once.
 *
 * An action with no `onClick` is a plain refusal ("Not now"): it closes the
 * toast and nothing else happens, which is the whole of declining an update
 * offer for this session.
 */
export interface NotificationAction {
  label: string
  onClick?: () => void
}

export interface NotificationOptions {
  duration?: number
  onClick?: () => void
  actions?: NotificationAction[]
}

export interface NotificationType {
  id: string
  body: string
  type: NotificationTypes
  options?: NotificationOptions
}

interface NotificationsContextType {
  notifications: NotificationType[]
  addNotification: (body: string, type: NotificationTypes, options?: NotificationOptions) => void
  removeNotification: (id: string) => void
}

const defaultValue: NotificationsContextType = { notifications: [], addNotification: () => {}, removeNotification: () => {} }

const NotificationsContext = createContext<NotificationsContextType>(defaultValue)

const NotificationsProvider = ({ children }: { children: React.ReactNode }): JSX.Element => {
  const { t } = useTranslation()
  const [notifications, setNotifications] = useState<NotificationType[]>([])

  useEffect((): (() => void) => {
    // An offer now, not an announcement (#184). Nothing has been downloaded at
    // this point and nothing will be until "Update now" is clicked, which is
    // the only path to appUpdater.downloadUpdate anywhere in the renderer.
    // Letting the toast expire, dismissing it, or answering "Not now" all mean
    // the same thing: this session downloads nothing, and the next launch's
    // check makes the offer again.
    const removeUpdateAvailableListener = window.api.appUpdater.onUpdateAvailable(({ version }) => {
      // The 2 second wait is App.tsx's start-up loader, which covers the whole
      // window (z-1000) for its first two seconds and would otherwise hide the
      // toast for exactly as long as it is on screen.
      setTimeout(() => {
        addNotification(t("notifications.body.updateAvailableConsent", { version }), "info", {
          duration: 60_000,
          actions: [
            {
              label: t("notifications.actions.updateNow"),
              onClick: (): void => {
                window.api.appUpdater.downloadUpdate()
                // Says where the progress bar the download drives can be found.
                // The task itself lives in the task manager, alongside every
                // other download the launcher runs.
                addNotification(t("notifications.body.downloading", { downloadName: launcherUpdateName(version) }), "info")
              }
            },
            { label: t("notifications.actions.notNow") }
          ]
        })
      }, 2_000)
    })

    const removeUpdateDownloadedListener = window.api.appUpdater.onUpdateDownloaded(() => {
      setTimeout(() => {
        addNotification(t("notifications.body.updateDownloaded"), "success", { onClick: () => window.api.appUpdater.updateAndRestart(), duration: 60_000 })
      }, 2_000)
    })

    return () => {
      removeUpdateAvailableListener()
      removeUpdateDownloadedListener()
    }
  }, [])

  const addNotification = (body: string, type: NotificationTypes, options?: NotificationOptions): void => {
    const id = uuidv4()
    const duration = options?.duration || 6000
    const onClick = options?.onClick
    const actions = options?.actions

    setNotifications((prev) => [...prev, { id, body, type, options: { duration, onClick, actions } }])

    setTimeout(() => {
      removeNotification(id)
    }, duration)
  }

  const removeNotification = (id: string): void => {
    setNotifications((prev) => prev.filter((notification) => notification.id !== id))
  }

  return <NotificationsContext.Provider value={{ notifications, addNotification, removeNotification }}>{children}</NotificationsContext.Provider>
}

const useNotificationsContext = (): NotificationsContextType => {
  const context = useContext(NotificationsContext)
  if (!context) {
    throw new Error("useNotificationsContext must be used within an NotificationsProvider")
  }
  return context
}

export { NotificationsProvider, useNotificationsContext }
