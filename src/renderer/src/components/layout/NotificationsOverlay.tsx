import { useRef } from "react"
import { motion, AnimatePresence } from "motion/react"
import { PiInfoDuotone, PiWarningDuotone, PiCheckCircleDuotone, PiProhibitInsetDuotone, PiXCircleDuotone } from "react-icons/pi"
import { useTranslation } from "react-i18next"

import clsx from "clsx"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { NormalButton } from "../ui/Buttons"

const BORDER_COLOR_TYPES = {
  success: "border-lime-600",
  info: "border-vs",
  error: "border-red-800",
  warning: "border-yellow-400"
}

const FONT_COLOR_TYPES = {
  success: "text-lime-600",
  info: "text-vsl",
  error: "text-red-700",
  warning: "text-yellow-400"
}

const ICON_TYPES = {
  success: <PiCheckCircleDuotone />,
  info: <PiInfoDuotone />,
  error: <PiProhibitInsetDuotone />,
  warning: <PiWarningDuotone />
}

function NotificationsOverlay(): JSX.Element {
  const { t } = useTranslation()
  const { notifications, removeNotification } = useNotificationsContext()

  /**
   * The toasts that have already been answered, and so must not be answered a
   * second time. Removing a notification takes it out of the list at once, but
   * AnimatePresence keeps the toast's node on screen until its exit animation
   * finishes, and that node stays clickable the whole way out. Three quick
   * clicks on "Update now" used to send three DOWNLOAD_UPDATE messages and
   * raise three "Starting download" toasts because of it.
   *
   * A ref rather than state, and not a `disabled` prop on the buttons either.
   * Once the notification is gone from the list AnimatePresence re-renders the
   * leaving toast from the element it cached, so no prop set after that point
   * ever reaches it; the only thing that can stop the second click is the
   * handler refusing to run, synchronously, on the click itself.
   */
  const answeredIds = useRef<Set<string>>(new Set())

  /** Runs a toast's answer at most once, then closes it. Every later click on the same toast does nothing at all. */
  function answerOnce(id: string, run?: () => void): void {
    if (answeredIds.current.has(id)) return

    // Toasts answered earlier have long since left the list, so their ids are
    // dropped here rather than piling up for the whole session. The one being
    // answered now is still in `notifications` (removeNotification has not run
    // yet), which is what keeps it through this sweep.
    const liveIds = new Set(notifications.map((notification) => notification.id))
    answeredIds.current = new Set([...answeredIds.current, id].filter((answeredId) => liveIds.has(answeredId)))

    run?.()
    removeNotification(id)
  }

  return (
    <div className="w-[20rem] h-fit absolute flex flex-col items-end top-2 right-2 z-800 gap-2">
      <AnimatePresence>
        {notifications.map(({ id, body, type, options }) => (
          <motion.div
            key={id}
            className={clsx(
              "w-full flex items-center justify-between gap-2 p-2 rounded-sm text-center bg-zinc-950/60 backdrop-blur-sm border-l-4",
              BORDER_COLOR_TYPES[type],
              options?.onClick && "cursor-pointer"
            )}
            initial={{ x: 400 }}
            animate={{ x: 0 }}
            exit={{ x: 400 }}
            onClick={(e) => {
              e.stopPropagation()
              answerOnce(id, options?.onClick)
            }}
          >
            <div className="flex items-center gap-2 text-start">
              <span className={clsx("text-4xl p-1 rounded-full", FONT_COLOR_TYPES[type])}>{ICON_TYPES[type]}</span>
              <div className="flex flex-col items-start justify-center gap-2">
                <p className="text-xs text-zinc-400">{body}</p>
                {options?.actions && options.actions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {options.actions.map((action) => (
                      <NormalButton
                        key={action.label}
                        className="px-2 py-1 text-xs bg-zinc-800/60 border border-zinc-400/10 hover:bg-zinc-700/60"
                        title={action.label}
                        onClick={(e) => {
                          // Without this the click also reaches the toast's own
                          // onClick above, which would run the notification's
                          // generic action on the way past.
                          e.stopPropagation()
                          answerOnce(id, action.onClick)
                        }}
                      >
                        {action.label}
                      </NormalButton>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <NormalButton
              className="p-1 text-zinc-400"
              title={t("notifications.discard")}
              onClick={(e) => {
                e.stopPropagation()
                answerOnce(id)
              }}
            >
              <PiXCircleDuotone />
            </NormalButton>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export default NotificationsOverlay
