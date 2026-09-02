import { useEffect } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react"
import { PiBoxArrowDownDuotone, PiBoxArrowUpDuotone, PiDownloadDuotone, PiEnvelopeDuotone, PiEnvelopeOpenDuotone, PiPulseDuotone, PiWrenchDuotone, PiXCircleDuotone } from "react-icons/pi"
import clsx from "clsx"
import { useTranslation } from "react-i18next"

import { awaitsAnswer, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useTaskContext, type TaskType } from "@renderer/contexts/TaskManagerContext"
import { NormalButton } from "./Buttons"

const OPERATION_LABELS = {
  download: "components.tasksMenu.downloading",
  extract: "components.tasksMenu.extracting",
  install: "components.activityCenter.installing",
  compress: "components.tasksMenu.compressing"
} as const
const STATUS_COLORS = { pending: "text-vsl", "in-progress": "text-yellow-400", failed: "text-red-800", completed: "text-lime-600" } as const
const STATUS_LABELS = {
  pending: "components.activityCenter.starting",
  "in-progress": "components.activityCenter.inProgress",
  failed: "components.activityCenter.failed",
  completed: "components.activityCenter.completed"
} as const

function TaskIcon({ task }: Readonly<{ task: TaskType }>): JSX.Element {
  if (task.type === "download") return <PiDownloadDuotone />
  if (task.type === "install") return <PiWrenchDuotone />
  if (task.type === "extract") return <PiBoxArrowUpDuotone />
  return <PiBoxArrowDownDuotone />
}

function ActivityTask({ task, removeTask }: Readonly<{ task: TaskType; removeTask: (id: string) => void }>): JSX.Element {
  const { t } = useTranslation()
  const reduceMotion = useReducedMotion()
  const percent = Math.max(0, Math.min(100, Math.round(task.progress)))
  const terminal = task.status === "completed" || task.status === "failed"
  const statusKey = task.status === "in-progress" && percent === 100 ? "components.activityCenter.finalizing" : STATUS_LABELS[task.status]
  return (
    <li className="w-full flex flex-col odd:bg-zinc-800/30 even:bg-zinc-950/30 p-2 gap-1">
      <div className="w-full flex items-start justify-between gap-2 min-w-0">
        <div className="flex items-start gap-2 min-w-0">
          <span className={clsx("text-xl p-1 shrink-0", STATUS_COLORS[task.status])} aria-hidden="true">
            <TaskIcon task={task} />
          </span>
          <div className="flex flex-col items-start min-w-0">
            <p className="font-bold text-sm break-words">{task.name}</p>
            <p className="text-xs text-zinc-400 break-words">
              {t(OPERATION_LABELS[task.type])} · {t(statusKey)}
            </p>
            {task.desc && task.desc !== task.name && <p className="text-xs text-zinc-400 line-clamp-2">{task.desc}</p>}
            {task.status === "failed" && <p className="text-xs text-red-800">{t("components.tasksMenu.error")}</p>}
          </div>
        </div>
        {terminal && (
          <NormalButton
            className="p-1 text-zinc-400 shrink-0"
            title={t("components.activityCenter.discardTask")}
            ariaLabel={t("components.activityCenter.discardTask")}
            onClick={() => removeTask(task.id)}
          >
            <PiXCircleDuotone />
          </NormalButton>
        )}
      </div>
      {!terminal && (
        <div className="flex items-center gap-2 pl-9">
          <div className="w-full h-1 bg-zinc-900 rounded-full" role="progressbar" aria-label={task.name} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-valuetext={percent + "%"}>
            <motion.div
              className="h-full bg-vs rounded-full"
              initial={reduceMotion ? false : { width: percent + "%" }}
              animate={{ width: percent + "%" }}
              transition={reduceMotion ? { duration: 0 } : { ease: "easeInOut", duration: 0.2 }}
            />
          </div>
          <span className="text-xs text-zinc-400 tabular-nums shrink-0">{percent}%</span>
        </div>
      )}
    </li>
  )
}

function TaskSection({ id, title, items, removeTask }: Readonly<{ id: string; title: string; items: TaskType[]; removeTask: (id: string) => void }>): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <section aria-labelledby={"activity-" + id}>
      <h3 id={"activity-" + id} className="px-2 pt-2 pb-1 text-xs uppercase tracking-wide text-zinc-400">
        {title}
      </h3>
      <ul>
        {items.map((task) => (
          <ActivityTask key={task.id} task={task} removeTask={removeTask} />
        ))}
      </ul>
    </section>
  )
}

/**
 * The panel body. Rendered only while the Popover is open, so its mount is the
 * "user opened the Activity Center" signal that marks every center record seen.
 */
function ActivityPanel(): JSX.Element {
  const { t } = useTranslation()
  const reduceMotion = useReducedMotion()
  const { tasks, activeTaskCount, removeTask } = useTaskContext()
  const { history, unreadCount, markAllSeen, markAllRead, setNotificationRead, clearReadNotifications, invokeAction, removeNotification } = useNotificationsContext()

  // Mounting means the center is open; a record arriving while it is open is on
  // screen, so it counts as seen too.
  useEffect(() => {
    markAllSeen()
  }, [history.length, markAllSeen])

  const activeTasks = tasks.filter((task) => task.status === "pending" || task.status === "in-progress")
  const failedTasks = tasks.filter((task) => task.status === "failed")
  const completedTasks = tasks.filter((task) => task.status === "completed")
  const hasClearableRead = history.some((notification) => notification.read && !awaitsAnswer(notification))

  return (
    <motion.div
      role="region"
      aria-labelledby="activity-center-title"
      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      className="max-h-[32rem] flex flex-col bg-zinc-950/50 backdrop-blur-md border border-zinc-400/5 shadow-sm shadow-zinc-950/50 rounded-sm overflow-y-auto text-sm"
    >
      <div className="flex flex-col gap-0.5 p-2 border-b border-zinc-400/5">
        <h2 id="activity-center-title" className="font-bold leading-tight">
          {t("components.activityCenter.title")}
        </h2>
        <span className="text-xs text-zinc-400 leading-tight" aria-live="polite" aria-atomic="true">
          {t("components.activityCenter.panelSummary", { active: activeTaskCount, unread: unreadCount })}
        </span>
      </div>
      <TaskSection id="in-progress" title={t("components.activityCenter.inProgressHeading")} items={activeTasks} removeTask={removeTask} />
      <TaskSection id="attention" title={t("components.activityCenter.attentionHeading")} items={failedTasks} removeTask={removeTask} />
      <TaskSection id="completed" title={t("components.activityCenter.completedHeading")} items={completedTasks} removeTask={removeTask} />
      <section aria-labelledby="activity-notifications">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 pt-2 pb-1">
          <h3 id="activity-notifications" className="text-xs uppercase tracking-wide text-zinc-400">
            {t("components.activityCenter.notificationsHeading")}
          </h3>
          <div className="flex flex-wrap gap-1">
            {unreadCount > 0 && (
              <NormalButton className="px-1 text-xs text-vsl" title={t("components.activityCenter.markAllRead")} ariaLabel={t("components.activityCenter.markAllRead")} onClick={() => markAllRead()}>
                {t("components.activityCenter.markAllRead")}
              </NormalButton>
            )}
            {hasClearableRead && (
              <NormalButton
                className="px-1 text-xs text-zinc-400"
                title={t("components.activityCenter.clearRead")}
                ariaLabel={t("components.activityCenter.clearRead")}
                onClick={() => clearReadNotifications()}
              >
                {t("components.activityCenter.clearRead")}
              </NormalButton>
            )}
          </div>
        </div>
        {history.length === 0 ? (
          <p className="p-4 text-center text-sm font-bold text-zinc-400">{t(tasks.length === 0 ? "components.activityCenter.noActivity" : "components.activityCenter.noNotifications")}</p>
        ) : (
          <ul>
            {history
              .slice()
              .reverse()
              .map((notification) => {
                const toggleLabel = t(notification.read ? "components.activityCenter.markUnread" : "components.activityCenter.markRead")
                return (
                  <li key={notification.id} className={clsx("p-2 border-t border-zinc-400/5", !notification.read && "bg-zinc-800/30")}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0">
                        {!notification.read && <span className="mt-1 w-1.5 h-1.5 rounded-full bg-vsl shrink-0" aria-hidden="true" />}
                        <p className="text-xs break-words text-zinc-400">{notification.body}</p>
                      </div>
                      <div className="flex items-start gap-1 shrink-0">
                        <NormalButton className="p-1 text-zinc-400" title={toggleLabel} ariaLabel={toggleLabel} onClick={() => setNotificationRead(notification.id, !notification.read)}>
                          {notification.read ? <PiEnvelopeDuotone /> : <PiEnvelopeOpenDuotone />}
                        </NormalButton>
                        <NormalButton className="p-1 text-zinc-400" title={t("notifications.discard")} ariaLabel={t("notifications.discard")} onClick={() => removeNotification(notification.id)}>
                          <PiXCircleDuotone />
                        </NormalButton>
                      </div>
                    </div>
                    {notification.resolvedWith && <p className="mt-1 text-xs text-zinc-400">{t("components.activityCenter.answeredWith", { action: notification.resolvedWith })}</p>}
                    {!notification.resolved && notification.options?.actions && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {notification.options.actions.map((action, index) => {
                          const actionId = action.id ?? "action-" + index
                          return (
                            <NormalButton
                              key={actionId}
                              className="px-2 py-1 text-xs bg-zinc-800/60 border border-zinc-400/10"
                              title={action.label}
                              ariaLabel={action.label}
                              onClick={() => invokeAction(notification.id, actionId)}
                            >
                              {action.label}
                            </NormalButton>
                          )
                        })}
                      </div>
                    )}
                  </li>
                )
              })}
          </ul>
        )}
      </section>
    </motion.div>
  )
}

function ActivityCenter(): JSX.Element {
  const { t } = useTranslation()
  const { activeTaskCount } = useTaskContext()
  const { unseenCount } = useNotificationsContext()

  return (
    <Popover className="relative">
      {({ open }) => (
        <>
          <PopoverButton
            title={t("components.activityCenter.title")}
            aria-label={
              t("components.activityCenter.title") +
              ": " +
              t("components.activityCenter.activeTasks", { count: activeTaskCount }) +
              ", " +
              t("components.activityCenter.newNotifications", { count: unseenCount })
            }
            className={clsx(
              "relative w-8 h-8 aspect-square flex items-center justify-center gap-1 rounded-sm overflow-visible border bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-vsl",
              activeTaskCount > 0 || unseenCount > 0 ? "border-vsl" : "border-zinc-400/5"
            )}
          >
            <PiPulseDuotone aria-hidden="true" />
            {activeTaskCount > 0 && (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 z-10 min-w-4 h-4 px-0.5 flex items-center justify-center rounded-full bg-vs text-[10px] leading-none text-white tabular-nums ring-1 ring-zinc-400/20"
              >
                {activeTaskCount}
              </span>
            )}
            {unseenCount > 0 && <span className="absolute left-0.5 bottom-0.5 w-1.5 h-1.5 rounded-full bg-vsl" aria-hidden="true" />}
          </PopoverButton>
          <AnimatePresence>
            {open && (
              <PopoverPanel static anchor="bottom" className="w-96 z-600 mt-1 ml-2 select-none rounded-sm overflow-hidden">
                <ActivityPanel />
              </PopoverPanel>
            )}
          </AnimatePresence>
        </>
      )}
    </Popover>
  )
}

export default ActivityCenter
