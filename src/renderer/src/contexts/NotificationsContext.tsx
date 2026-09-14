import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { duplicateToastId, type RepeatableToast } from "@domain/notifications/duplicateToast"
import { type FailureReason } from "@domain/notifications/failureReason"
import { MAX_VISIBLE_TOASTS, backlogToastDuration, capNotificationRecords, waitingBehindStack } from "@domain/notifications/toastQueue"

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
  /**
   * Why this failed, as a token the locale turns into a sentence under the
   * message in the Activity Center. Set by the call site that caught the error,
   * which is the only place that ever sees the raw text.
   */
  reason?: FailureReason
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
  /**
   * How many times this same message has arrived, counting the first. Above one
   * the banner wears the count, because folding a repeat into a banner already
   * on screen would otherwise look like the second one went missing.
   */
  repeats: number
  options?: NotificationOptions
}

/** One banner on screen: the record it shows, the turn it got and whether its countdown is held. */
export interface PresentedToast {
  record: NotificationType
  /** The turn this banner actually got, which a backlog shortens. Drives its countdown bar. */
  turn: number | null
  /** True while the pointer is over this banner or focus is inside it. */
  paused: boolean
}

interface NotificationsContextType {
  /** Every banner on screen, oldest first, so the newest is drawn at the bottom of the stack. */
  notifications: NotificationType[]
  history: NotificationType[]
  activeToasts: PresentedToast[]
  /** The newest banner on screen, which is the one a single-toast probe means. */
  activeToast?: NotificationType
  /** Center records the user has not had a chance to see yet. Drives the trigger dot. */
  unseenCount: number
  /** Center records the user has not acknowledged. Drives the panel row marker. */
  unreadCount: number
  /** True while any banner on screen is holding its countdown. */
  toastPaused: boolean
  /** The banners whose countdown is held, named by id. The overlay owns this and rewrites the whole set. */
  setPausedToasts: (ids: readonly string[]) => void
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
  activeToasts: [],
  unseenCount: 0,
  unreadCount: 0,
  toastPaused: false,
  setPausedToasts: () => {},
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

/** One banner's place in the stack: which record it shows and the turn it was given. */
interface StackedToast {
  id: string
  turn: number | null
}

/**
 * One banner's countdown, as a component so each place in the stack owns its
 * own timer and its own pause instead of the provider reconciling a map of
 * them by hand.
 *
 * Keyed on the id, the turn it was given and the pause flag, and on nothing
 * else, deliberately: opening the Activity Center marks a visible toast's
 * record `seen`, replacing the record object while its id stays the same.
 * Depending on the whole record would restart the countdown on every seen/read
 * mutation, so a player who keeps opening the panel could pin a toast on screen
 * forever. The repeat count is the one part of the record that is in there, and
 * the one thing that does restart it: a message folded into this banner arrived
 * just now, and the player has to get a turn to read it.
 */
function ToastTimer({
  id,
  turn,
  paused,
  repeats,
  onStart,
  onExpire
}: Readonly<{ id: string; turn: number | null; paused: boolean; repeats: number; onStart: (id: string) => void; onExpire: (id: string) => void }>): null {
  useEffect(() => {
    if (turn == null || paused) return
    onStart(id)
    const timeout = window.setTimeout((): void => onExpire(id), turn)
    return (): void => window.clearTimeout(timeout)
  }, [id, turn, paused, repeats, onStart, onExpire])

  return null
}

const NotificationsProvider = ({ children }: { children: React.ReactNode }): JSX.Element => {
  const { t } = useTranslation()
  const [records, setRecords] = useState<readonly NotificationType[]>([])
  const [toastQueue, setToastQueue] = useState<string[]>([])
  // The stack, oldest first. Each entry carries the turn it was given, decided
  // once when it took its place: a backlog cannot keep shortening a banner that
  // is already up, and a queue that drains while it is up cannot lengthen it
  // back.
  const [stack, setStack] = useState<readonly StackedToast[]>([])
  const [pausedToastIds, setPausedToasts] = useState<readonly string[]>([])
  // Read by the record cap so a burst never drops a toast being read. A ref
  // rather than the state itself: addNotification is handed out through the
  // context and may run from a closure that predates the current stack.
  const stackRef = useRef<readonly StackedToast[]>([])
  // Same reason as stackRef: addNotification may run from a closure older than
  // the current queue or record list, and folding a repeat has to look at both
  // as they are now.
  const toastQueueRef = useRef<readonly string[]>([])
  const recordsRef = useRef<readonly NotificationType[]>([])
  // Toasts added since the last render, which no state has caught up with yet.
  // A burst fired in one tick is several addNotification calls before a single
  // render, and without these the second of two identical ones cannot see the
  // first. Emptied on every render, by which point they are in `records`.
  const pendingToasts = useRef<RepeatableToast[]>([])
  // When each banner's turn started, refreshed by every (re)start of its timer,
  // so the shortening effect can read how much of that turn is already gone.
  const turnStartedAt = useRef(new Map<string, number>())
  // dismissToast is rebuilt on every render, and a timer whose expiry callback
  // changed identity would be torn down and restarted on every render, so it
  // would never fire. The two handed to ToastTimer are stable and read the
  // current dismissToast through this ref.
  const dismissRef = useRef<(id: string, reason?: ToastDismissReason) => void>(() => {})
  const expireToast = useCallback((id: string): void => dismissRef.current(id, "timeout"), [])
  const startTurn = useCallback((id: string): void => {
    turnStartedAt.current.set(id, Date.now())
  }, [])
  const invokedActions = useRef<Set<string>>(new Set())
  const offeredVersion = useRef("")
  const downloadAccepted = useRef(false)

  const history = useMemo(() => records.filter((record) => !isToastOnly(record)), [records])
  stackRef.current = stack
  toastQueueRef.current = toastQueue
  recordsRef.current = records
  pendingToasts.current = []
  const activeToasts = useMemo(
    () =>
      stack.flatMap((entry) => {
        const record = records.find((candidate) => candidate.id === entry.id)
        return record ? [{ record, turn: entry.turn, paused: pausedToastIds.includes(entry.id) }] : []
      }),
    [stack, records, pausedToastIds]
  )
  const unseenCount = useMemo(() => history.filter((record) => !record.seen).length, [history])
  const unreadCount = useMemo(() => history.filter((record) => !record.read).length, [history])

  // The stack names records, not the records themselves, and something can take
  // one away without going through dismissToast: clearReadNotifications drops a
  // banner the moment its row is marked read, "Clear all" drops the lot, and the
  // record cap can drop a hand-off whose id stackRef has not caught up with yet.
  // Left as is, the banner draws nothing and its place in the stack stays taken,
  // so the queue waits out a timer for a toast nobody can see. This runs before
  // the hand-off in the same flush so the freed place is filled immediately.
  useEffect(() => {
    const live = stack.filter((entry) => records.some((record) => record.id === entry.id))
    if (live.length !== stack.length) setStack(live)
  }, [stack, records])

  // Only a banner on screen owns a timer. Queued messages cannot expire unseen.
  useEffect(() => {
    if (toastQueue.length === 0) return
    const live = toastQueue.filter((id) => records.some((record) => record.id === id))
    const admitted = live.slice(0, Math.max(0, MAX_VISIBLE_TOASTS - stack.length))
    if (admitted.length === 0) {
      if (live.length !== toastQueue.length) setToastQueue(live)
      return
    }
    const waiting = live.length - admitted.length
    setStack((current) => [...current, ...admitted.map((id) => ({ id, turn: backlogToastDuration(records.find((record) => record.id === id)?.options?.duration ?? null, waiting) }))])
    setToastQueue(live.slice(admitted.length))
  }, [stack, records, toastQueue])

  // A turn is decided when a banner takes its place, when nothing may have been
  // waiting yet, and was then left untouched: a burst that starts behind a fresh
  // 8s error sat out the full eight before the first of the burst got a place.
  // This gives every banner already up BACKLOG_TOAST_DURATION from the moment
  // the queue grew, and never more than it already had (`shortened < remaining`
  // only holds when there was more than the backlog turn left, so it converges
  // in one step and cannot drip milliseconds off under a real clock). A paused
  // banner is left alone: its clock is not running, and leaving it hands back a
  // whole turn anyway. A question (`turn == null`) keeps its place. Declared
  // after the hand-off so `turnStartedAt` is already fresh this flush.
  useEffect(() => {
    const waiting = waitingBehindStack(toastQueue.length, stack.length)
    if (waiting === 0) return
    setStack((current) => {
      let changed = false
      const next = current.map((entry) => {
        if (entry.turn == null || pausedToastIds.includes(entry.id)) return entry
        const remaining = entry.turn - (Date.now() - (turnStartedAt.current.get(entry.id) ?? Date.now()))
        const shortened = backlogToastDuration(remaining, waiting)
        if (shortened === null || shortened >= remaining) return entry
        changed = true
        return { id: entry.id, turn: shortened }
      })
      return changed ? next : current
    })
  }, [stack, pausedToastIds, toastQueue])

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
    const presentation = options?.presentation ?? "both"
    const hasActions = Boolean(options?.actions?.length)

    // A message the player can already see, or is about to, is refreshed rather
    // than repeated: the count on the banner is what says it happened twice.
    // Only where there is a banner, because a center record the player has
    // scrolled past is history, and history is meant to hold both entries.
    if (presentation !== "center") {
      const onScreenOrWaiting = [...stackRef.current.map((entry) => entry.id), ...toastQueueRef.current].flatMap((toastId) => {
        const candidate = recordsRef.current.find((record) => record.id === toastId)
        return candidate ? [{ id: candidate.id, body: candidate.body, type: candidate.type, hasActions: Boolean(candidate.options?.actions?.length) }] : []
      })
      const repeated = duplicateToastId([...onScreenOrWaiting, ...pendingToasts.current], { body, type, hasActions })
      if (repeated !== undefined) {
        // The record cap could in principle have dropped the one being folded
        // into, in the same tick, behind a burst wide enough to overflow the
        // toast budget; the count would then land on nothing. Left as is: it
        // takes a burst of eight identical-plus-different messages in one tick.
        setRecords((previous) => previous.map((record) => (record.id === repeated ? { ...record, repeats: record.repeats + 1, createdAt: Date.now() } : record)))
        return
      }
    }

    const id = crypto.randomUUID()
    const record: NotificationType = {
      id,
      body,
      type,
      createdAt: Date.now(),
      seen: false,
      read: false,
      resolved: false,
      repeats: 1,
      options: { ...options, presentation, duration: resolveToastDuration(type, options) }
    }
    setRecords((previous) => capNotificationRecords([...previous, record], isToastOnly, (candidate) => stackRef.current.some((entry) => entry.id === candidate.id)))
    if (presentation !== "center") {
      pendingToasts.current.push({ id, body, type, hasActions })
      setToastQueue((queue) => [...queue, id])
    }
  }

  const dismissToast = (id: string, reason: ToastDismissReason = "manual"): void => {
    setStack((current) => (current.some((entry) => entry.id === id) ? current.filter((entry) => entry.id !== id) : current))
    // The pause set is not touched here: the overlay region owns it, and a
    // banner that takes a freed place under a pointer that never moved must
    // come up paused (#398). The region reconciles it when the pointer moves.
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

  dismissRef.current = dismissToast

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
    setStack((current) => (current.some((entry) => entry.id === id) ? current.filter((entry) => entry.id !== id) : current))
    setToastQueue((queue) => queue.filter((queuedId) => queuedId !== id))
    setRecords((previous) => previous.filter((record) => record.id !== id))
  }
  const clearReadNotifications = (): void => {
    setRecords((previous) => previous.filter((record) => !record.read || awaitsAnswer(record)))
  }

  return (
    <NotificationsContext.Provider
      value={{
        history,
        notifications: activeToasts.map((entry) => entry.record),
        activeToasts,
        activeToast: activeToasts.at(-1)?.record,
        unseenCount,
        unreadCount,
        toastPaused: pausedToastIds.length > 0,
        setPausedToasts,
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
      {/* One timer per place in the stack, mounted as children so each starts, pauses and expires on
          its own. They render nothing; the overlay draws the banners. */}
      {stack.map((entry) => (
        <ToastTimer
          key={entry.id}
          id={entry.id}
          turn={entry.turn}
          paused={pausedToastIds.includes(entry.id)}
          repeats={records.find((record) => record.id === entry.id)?.repeats ?? 1}
          onStart={startTurn}
          onExpire={expireToast}
        />
      ))}
      {children}
    </NotificationsContext.Provider>
  )
}

const useNotificationsContext = (): NotificationsContextType => useContext(NotificationsContext)

export { NotificationsProvider, useNotificationsContext }
