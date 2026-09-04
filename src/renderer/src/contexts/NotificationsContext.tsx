import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

export type NotificationTypes = "success" | "error" | "info" | "warning"
export type NotificationPresentation = "toast" | "center" | "both"
export type ToastDismissReason = "manual" | "timeout"

export interface NotificationAction {
  id?: string
  label: string
  onClick?: () => void
}

export interface NotificationOptions {
  /** Milliseconds before an unhandled toast closes; null keeps it open. */
  duration?: number | null
  actions?: NotificationAction[]
  presentation?: NotificationPresentation
}

export interface NotificationType {
  id: string
  body: string
  type: NotificationTypes
  createdAt: number
  /**
   * The center has been open with this record in it, or its banner was closed
   * by hand. Governs the trigger's new-activity dot, and never goes back to
   * false: once the user has had the chance to look, the trigger stays quiet.
   */
  seen: boolean
  /** The user acknowledged it: the row toggle, "Mark all read", or answering it. Governs the row marker and admits it to "Clear read". */
  read: boolean
  /** Only meaningful with `options.actions`: the question has been answered. */
  resolved: boolean
  /** Label of the action that answered it, so an answered question does not sit in the center still asking. */
  resolvedWith?: string
  options?: NotificationOptions
}

interface NotificationsContextType {
  /** The currently presented toast. Kept as an array for existing probes. */
  notifications: NotificationType[]
  history: NotificationType[]
  activeToast?: NotificationType
  /** Center records the user has not had a chance to see yet. Drives the trigger dot. */
  unseenCount: number
  /** Center records the user has not acknowledged. Drives the panel row marker. */
  unreadCount: number
  addNotification: (body: string, type: NotificationTypes, options?: NotificationOptions) => void
  dismissToast: (id: string, reason?: ToastDismissReason) => void
  invokeAction: (notificationId: string, actionId: string) => void
  markAllSeen: () => void
  markAllRead: () => void
  setNotificationRead: (id: string, read: boolean) => void
  removeNotification: (id: string) => void
  clearReadNotifications: () => void
}

const defaultValue: NotificationsContextType = {
  notifications: [],
  history: [],
  unseenCount: 0,
  unreadCount: 0,
  addNotification: () => {},
  dismissToast: () => {},
  invokeAction: () => {},
  markAllSeen: () => {},
  markAllRead: () => {},
  setNotificationRead: () => {},
  removeNotification: () => {},
  clearReadNotifications: () => {}
}

const NotificationsContext = createContext<NotificationsContextType>(defaultValue)
const MAX_HISTORY = 50
const DEFAULT_TOAST_DURATIONS: Record<NotificationTypes, number> = { success: 4500, info: 4500, warning: 8000, error: 8000 }

function resolveToastDuration(type: NotificationTypes, options?: NotificationOptions): number | null {
  if (options?.duration !== undefined) return options.duration
  if (options?.actions && options.actions.length > 0) return null
  return DEFAULT_TOAST_DURATIONS[type]
}

/** True while an actionable record still has an unanswered question on it. */
export function awaitsAnswer(record: NotificationType): boolean {
  return Boolean(record.options?.actions?.length) && !record.resolved
}

/**
 * Trims to MAX_HISTORY *center* records. Toast-only entries share `records`
 * but are transient and must never push real history out of it: a bulk mod
 * update parks dozens of queued toasts here at once.
 */
function capHistory(records: NotificationType[]): NotificationType[] {
  let excess = records.reduce((count, record) => count + (record.options?.presentation === "toast" ? 0 : 1), 0) - MAX_HISTORY
  if (excess <= 0) return records
  return records.filter((record) => {
    if (excess <= 0 || record.options?.presentation === "toast") return true
    excess -= 1
    return false
  })
}

const NotificationsProvider = ({ children }: { children: React.ReactNode }): JSX.Element => {
  const { t } = useTranslation()
  const [records, setRecords] = useState<NotificationType[]>([])
  const [toastQueue, setToastQueue] = useState<string[]>([])
  const [activeToastId, setActiveToastId] = useState<string | null>(null)
  const invokedActions = useRef<Set<string>>(new Set())
  const offeredVersion = useRef("")
  const downloadAccepted = useRef(false)

  const history = useMemo(() => records.filter((record) => record.options?.presentation !== "toast"), [records])
  const activeToast = activeToastId ? records.find((record) => record.id === activeToastId) : undefined
  const unseenCount = useMemo(() => history.filter((record) => !record.seen).length, [history])
  const unreadCount = useMemo(() => history.filter((record) => !record.read).length, [history])

  // Only the presented toast owns a timer. Queued messages cannot expire unseen.
  useEffect(() => {
    if (activeToastId || toastQueue.length === 0) return
    const nextId = toastQueue[0]
    if (!nextId) return
    if (!records.some((record) => record.id === nextId)) {
      setToastQueue((queue) => queue.slice(1))
      return
    }
    setActiveToastId(nextId)
    setToastQueue((queue) => queue.slice(1))
  }, [activeToastId, records, toastQueue])

  // Keyed on the toast id alone, deliberately: opening the Activity Center
  // marks the visible toast's record `seen`, replacing the record object while
  // its id stays the same. Depending on `activeToast` here would restart the
  // countdown on every seen/read mutation, so a user who keeps opening the
  // panel could pin a toast on screen forever. `dismissToast` only ever calls
  // functional setState updaters, so the captured copy is safe to reuse.
  useEffect(() => {
    if (!activeToast || activeToast.options?.duration == null) return
    const timeout = window.setTimeout((): void => dismissToast(activeToast.id, "timeout"), activeToast.options.duration)
    return (): void => window.clearTimeout(timeout)
    // The timer follows the toast id. Depending on the whole record would restart it when
    // Activity Center marks the record seen or read, allowing a toast to remain forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeToast?.id])

  useEffect((): (() => void) => {
    const offerDownload = (body: string): void => {
      addNotification(body, "info", {
        duration: null,
        actions: [
          {
            id: "update-now",
            label: t("notifications.actions.updateNow"),
            onClick: (): void => {
              downloadAccepted.current = true
              window.api.appUpdater.downloadUpdate()
            }
          },
          { id: "not-now", label: t("notifications.actions.notNow") }
        ]
      })
    }

    const removeUpdateAvailableListener = window.api.appUpdater.onUpdateAvailable(({ version }) => {
      offeredVersion.current = version
      window.setTimeout(() => offerDownload(t("notifications.body.updateAvailableConsent", { version })), 2_000)
    })
    const removeUpdateErrorListener = window.api.appUpdater.onUpdateError(() => {
      if (!downloadAccepted.current) return
      downloadAccepted.current = false
      offerDownload(t("notifications.body.updateDownloadFailedRetry", { version: offeredVersion.current }))
    })
    const removeUpdateDownloadedListener = window.api.appUpdater.onUpdateDownloaded(() => {
      window.setTimeout(() => {
        addNotification(t("notifications.body.updateDownloaded"), "success", {
          duration: null,
          actions: [{ id: "restart-and-update", label: t("components.activityCenter.restartAndUpdate"), onClick: (): void => window.api.appUpdater.updateAndRestart() }]
        })
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
    const presentation = options?.presentation ?? "both"
    const record: NotificationType = {
      id,
      body,
      type,
      createdAt: Date.now(),
      seen: false,
      read: false,
      resolved: false,
      options: { ...options, presentation, duration: resolveToastDuration(type, options) }
    }
    setRecords((previous) => capHistory([...previous, record]))
    if (presentation !== "center") setToastQueue((queue) => [...queue, id])
  }

  const dismissToast = (id: string, reason: ToastDismissReason = "manual"): void => {
    setActiveToastId((activeId) => (activeId === id ? null : activeId))
    setToastQueue((queue) => queue.filter((queuedId) => queuedId !== id))
    // A banner closed by hand has been dealt with, so it stops counting as new;
    // one that timed out has not, because the user may have been elsewhere.
    setRecords((previous) =>
      previous.flatMap((record) => {
        if (record.id !== id) return [record]
        if (record.options?.presentation === "toast") return []
        return reason === "manual" && !record.seen ? [{ ...record, seen: true }] : [record]
      })
    )
  }

  const invokeAction = (notificationId: string, actionId: string): void => {
    const guardKey = `${notificationId}:${actionId}`
    if (invokedActions.current.has(guardKey)) return
    const record = records.find((candidate) => candidate.id === notificationId)
    const action = record?.options?.actions?.find((candidate, index) => (candidate.id ?? `action-${index}`) === actionId)
    if (!record || !action) return
    invokedActions.current.add(guardKey)
    setRecords((previous) => previous.map((candidate) => (candidate.id === notificationId ? { ...candidate, seen: true, read: true, resolved: true, resolvedWith: action.label } : candidate)))
    action.onClick?.()
    dismissToast(notificationId, "manual")
  }

  // useCallback because the Activity Center's mark-seen effect lists this in its
  // dependency array; the identity stays stable and the state bail-out stops
  // that effect from looping.
  const markAllSeen = useCallback((): void => {
    setRecords((previous) =>
      previous.some((record) => record.options?.presentation !== "toast" && !record.seen)
        ? previous.map((record) => (record.options?.presentation === "toast" ? record : { ...record, seen: true }))
        : previous
    )
  }, [])

  const markAllRead = (): void => setRecords((previous) => (previous.some((record) => !record.read || !record.seen) ? previous.map((record) => ({ ...record, seen: true, read: true })) : previous))
  const setNotificationRead = (id: string, read: boolean): void => setRecords((previous) => previous.map((record) => (record.id === id ? { ...record, seen: true, read } : record)))
  const removeNotification = (id: string): void => {
    setActiveToastId((activeId) => (activeId === id ? null : activeId))
    setToastQueue((queue) => queue.filter((queuedId) => queuedId !== id))
    setRecords((previous) => previous.filter((record) => record.id !== id))
  }
  const clearReadNotifications = (): void => {
    setRecords((previous) => previous.filter((record) => !record.read || awaitsAnswer(record)))
  }

  const activeNotifications = activeToast ? [activeToast] : []
  return (
    <NotificationsContext.Provider
      value={{
        history,
        notifications: activeNotifications,
        activeToast,
        unseenCount,
        unreadCount,
        addNotification,
        dismissToast,
        invokeAction,
        markAllSeen,
        markAllRead,
        setNotificationRead,
        removeNotification,
        clearReadNotifications
      }}
    >
      {children}
    </NotificationsContext.Provider>
  )
}

const useNotificationsContext = (): NotificationsContextType => useContext(NotificationsContext)

export { NotificationsProvider, useNotificationsContext }
