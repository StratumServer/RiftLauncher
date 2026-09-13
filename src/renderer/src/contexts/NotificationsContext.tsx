import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { backlogToastDuration, capNotificationRecords } from "@domain/notifications/toastQueue"

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
  /** The turn the presented toast actually got, which a backlog shortens. Drives the countdown bar. */
  activeToastDuration: number | null
  /** True while the pointer is over the toast or focus is inside it, which holds the countdown. */
  toastPaused: boolean
  setToastPaused: (paused: boolean) => void
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
  activeToastDuration: null,
  toastPaused: false,
  setToastPaused: () => {},
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
const DEFAULT_TOAST_DURATIONS: Record<NotificationTypes, number> = { success: 4500, info: 4500, warning: 8000, error: 8000 }

function resolveToastDuration(type: NotificationTypes, options?: NotificationOptions): number | null {
  if (options?.duration !== undefined) return options.duration
  if (options?.actions && options.actions.length > 0) return null
  return DEFAULT_TOAST_DURATIONS[type]
}

/** True while an actionable record still has an unanswered question on it. */
/** A transient banner with no place in the Activity Center. */
function isToastOnly(record: NotificationType): boolean {
  return record.options?.presentation === "toast"
}

export function awaitsAnswer(record: NotificationType): boolean {
  return Boolean(record.options?.actions?.length) && !record.resolved
}

const NotificationsProvider = ({ children }: { children: React.ReactNode }): JSX.Element => {
  const { t } = useTranslation()
  const [records, setRecords] = useState<readonly NotificationType[]>([])
  const [toastQueue, setToastQueue] = useState<string[]>([])
  const [activeToastId, setActiveToastId] = useState<string | null>(null)
  // The turn the presented toast got, decided once when it took the screen. A
  // backlog cannot keep shortening a banner that is already up, and a queue
  // that drains while it is up cannot lengthen it back.
  const [activeToastDuration, setActiveToastDuration] = useState<number | null>(null)
  const [toastPaused, setToastPaused] = useState(false)
  // Read by the record cap so a burst never drops the toast being read. A ref
  // rather than the state itself: addNotification is handed out through the
  // context and may run from a closure that predates the current banner.
  const activeToastIdRef = useRef<string | null>(null)
  // When the turn the current banner is running started, refreshed by every
  // (re)start of the timer effect below, so the shortening effect can read how
  // much of the turn is already gone.
  const toastTurnStartedAt = useRef(0)
  const invokedActions = useRef<Set<string>>(new Set())
  const offeredVersion = useRef("")
  const downloadAccepted = useRef(false)

  const history = useMemo(() => records.filter((record) => !isToastOnly(record)), [records])
  const activeToast = activeToastId ? records.find((record) => record.id === activeToastId) : undefined
  activeToastIdRef.current = activeToastId
  const unseenCount = useMemo(() => history.filter((record) => !record.seen).length, [history])
  const unreadCount = useMemo(() => history.filter((record) => !record.read).length, [history])

  // activeToastId names a record, not the record itself, and something can take
  // that record away without going through dismissToast: clearReadNotifications
  // drops the banner on screen the moment its row is marked read, and the record
  // cap can drop a hand-off whose id activeToastIdRef has not caught up with yet.
  // Left as is, activeToast goes undefined, the overlay draws nothing, and the
  // hand-off effect below stays blocked on the truthy id, so the whole queue
  // waits out a timer for a toast nobody can see. This runs before the hand-off
  // in the same flush so the freed screen is handed on immediately.
  useEffect(() => {
    if (!activeToastId || records.some((record) => record.id === activeToastId)) return
    setActiveToastId(null)
    setActiveToastDuration(null)
  }, [activeToastId, records])

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
    setActiveToastDuration(backlogToastDuration(records.find((record) => record.id === nextId)?.options?.duration ?? null, toastQueue.length - 1))
    setToastQueue((queue) => queue.slice(1))
  }, [activeToastId, records, toastQueue])

  // Keyed on the toast id, the turn it was given and the pause flag, and on
  // nothing else, deliberately: opening the Activity Center marks the visible
  // toast's record `seen`, replacing the record object while its id stays the
  // same. Depending on `activeToast` here would restart the countdown on every
  // seen/read mutation, so a user who keeps opening the panel could pin a toast
  // on screen forever. `dismissToast` only ever calls functional setState
  // updaters, so the captured copy is safe to reuse.
  useEffect(() => {
    if (!activeToastId || activeToastDuration == null || toastPaused) return
    toastTurnStartedAt.current = Date.now()
    const timeout = window.setTimeout((): void => dismissToast(activeToastId, "timeout"), activeToastDuration)
    return (): void => window.clearTimeout(timeout)
    // The timer follows the toast id, its decided duration and the pause flag. Depending on the
    // whole record would restart it when Activity Center marks the record seen or read, allowing a
    // toast to remain forever. Leaving the toast gives it a fresh full turn rather than the
    // remainder of the old one, which is the reading time the player asked for by hovering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeToastId, activeToastDuration, toastPaused])

  // The turn is decided at hand-off, when nothing may have been waiting yet, and
  // was then left untouched: a burst that starts behind a fresh 8s error sat out
  // the full eight before the first of the burst got the screen. This gives the
  // banner already up BACKLOG_TOAST_DURATION from the moment the queue grew, and
  // never more than it already had (`shortened < remaining` only holds when
  // there was more than the backlog turn left, so it converges in one step and
  // cannot drip milliseconds off under a real clock). A paused banner is left
  // alone: its clock is not running, and leaving it hands back a whole turn
  // anyway. A question (`duration == null`) keeps its screen. Declared after the
  // timer effect so `toastTurnStartedAt` is already fresh this flush.
  useEffect(() => {
    if (!activeToastId || activeToastDuration == null || toastPaused || toastQueue.length === 0) return
    const remaining = activeToastDuration - (Date.now() - toastTurnStartedAt.current)
    const shortened = backlogToastDuration(remaining, toastQueue.length)
    if (shortened !== null && shortened < remaining) setActiveToastDuration(shortened)
  }, [activeToastId, activeToastDuration, toastPaused, toastQueue])

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
    setRecords((previous) => capNotificationRecords([...previous, record], isToastOnly, (candidate) => candidate.id === activeToastIdRef.current))
    if (presentation !== "center") setToastQueue((queue) => [...queue, id])
  }

  const dismissToast = (id: string, reason: ToastDismissReason = "manual"): void => {
    setActiveToastId((activeId) => (activeId === id ? null : activeId))
    // toastPaused is not cleared here: the overlay region owns it now, and a
    // hand-off to a banner still under the pointer must stay paused (#398). The
    // region's own mouseleave clears it when the pointer actually goes.
    setToastQueue((queue) => queue.filter((queuedId) => queuedId !== id))
    // A banner closed by hand has been dealt with, so it stops counting as new;
    // one that timed out has not, because the user may have been elsewhere.
    setRecords((previous) =>
      previous.flatMap((record) => {
        if (record.id !== id) return [record]
        if (isToastOnly(record)) return []
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
    setRecords((previous) => (previous.some((record) => !isToastOnly(record) && !record.seen) ? previous.map((record) => (isToastOnly(record) ? record : { ...record, seen: true })) : previous))
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
        activeToastDuration,
        toastPaused,
        setToastPaused,
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
