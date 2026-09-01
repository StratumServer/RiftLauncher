import { createContext, useState, useEffect, useContext, useRef } from "react"
import { useTranslation } from "react-i18next"

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

  /**
   * The version the main process offered, and whether the user accepted it.
   *
   * Both exist for the retry below. There is one update check per session, so
   * nothing will name the version a second time, and the error event says only
   * that something went wrong: an error that arrives before anyone accepted
   * anything is a failed check, not a failed download, and must not put a
   * download offer on screen.
   */
  const offeredVersion = useRef("")
  const downloadAccepted = useRef(false)

  useEffect((): (() => void) => {
    // An offer now, not an announcement (#184). Nothing has been downloaded at
    // this point and nothing will be until "Update now" is clicked, which is
    // the only path to appUpdater.downloadUpdate anywhere in the renderer.
    // Letting the toast expire, dismissing it, or answering "Not now" all mean
    // the same thing: this session downloads nothing, and the next launch's
    // check makes the offer again.
    const offerDownload = (body: string, version: string): void => {
      addNotification(body, "info", {
        duration: 60_000,
        actions: [
          {
            label: t("notifications.actions.updateNow"),
            onClick: (): void => {
              downloadAccepted.current = true
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
    }

    const removeUpdateAvailableListener = window.api.appUpdater.onUpdateAvailable(({ version }) => {
      offeredVersion.current = version
      // The 2 second wait is App.tsx's start-up loader, which covers the whole
      // window (z-1000) for its first two seconds and would otherwise hide the
      // toast for exactly as long as it is on screen.
      setTimeout(() => {
        offerDownload(t("notifications.body.updateAvailableConsent", { version }), version)
      }, 2_000)
    })

    // A download that dies halfway used to leave a red task in the list and
    // nothing else until the launcher was restarted, because the session's one
    // check had already happened and nothing was going to ask again. The offer
    // itself is still good (the main process cleared its re-entrancy guard on
    // the same error, and the version it found is still there), so the honest
    // thing is to ask again rather than make the user relaunch.
    const removeUpdateErrorListener = window.api.appUpdater.onUpdateError(() => {
      if (!downloadAccepted.current) return
      downloadAccepted.current = false
      offerDownload(t("notifications.body.updateDownloadFailedRetry", { version: offeredVersion.current }), offeredVersion.current)
    })

    const removeUpdateDownloadedListener = window.api.appUpdater.onUpdateDownloaded(() => {
      setTimeout(() => {
        addNotification(t("notifications.body.updateDownloaded"), "success", { onClick: () => window.api.appUpdater.updateAndRestart(), duration: 60_000 })
      }, 2_000)
    })

    return () => {
      removeUpdateAvailableListener()
      removeUpdateErrorListener()
      removeUpdateDownloadedListener()
    }
  }, [])

  const addNotification = (body: string, type: NotificationTypes, options?: NotificationOptions): void => {
    const id = crypto.randomUUID()
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

/**
 * The context ships the no-op `defaultValue` above, so a call from outside a
 * provider gets that and never nothing. There is no absent case to guard, which
 * is why this one has no throw where the task and config hooks have one.
 */
const useNotificationsContext = (): NotificationsContextType => useContext(NotificationsContext)

export { NotificationsProvider, useNotificationsContext }
