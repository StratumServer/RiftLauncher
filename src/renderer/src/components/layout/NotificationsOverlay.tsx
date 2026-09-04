import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { PiInfoDuotone, PiWarningDuotone, PiCheckCircleDuotone, PiProhibitInsetDuotone, PiXCircleDuotone } from "react-icons/pi"
import { useTranslation } from "react-i18next"
import clsx from "clsx"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { NormalButton } from "../ui/Buttons"

const FONT_COLOR_TYPES = { success: "text-lime-600", info: "text-vsl", error: "text-red-700", warning: "text-yellow-400" }
const TIMER_COLOR_TYPES = { success: "bg-lime-600", info: "bg-vs", error: "bg-red-800", warning: "bg-yellow-400" }
const ICON_TYPES = { success: <PiCheckCircleDuotone />, info: <PiInfoDuotone />, error: <PiProhibitInsetDuotone />, warning: <PiWarningDuotone /> }

function NotificationsOverlay(): JSX.Element {
  const { t } = useTranslation()
  const { activeToast, dismissToast, invokeAction } = useNotificationsContext()
  const reduceMotion = useReducedMotion()
  const toastDuration = activeToast?.options?.duration

  return (
    // Always-mounted polite live region: a queued toast inserted here minutes
    // later is still announced. A freshly mounted role="status" node is not.
    <div role="status" aria-live="polite" aria-atomic="false" className="w-[20rem] h-fit absolute flex flex-col items-end top-2 right-2 z-800 gap-2">
      <AnimatePresence>
        {activeToast && (
          <motion.div
            key={activeToast.id}
            // Errors keep their own assertive region, which does announce on
            // insertion; everything else is announced by the polite parent.
            role={activeToast.type === "error" ? "alert" : undefined}
            className="relative w-full flex items-center justify-between gap-2 p-2 rounded-sm text-center bg-zinc-950/60 backdrop-blur-sm overflow-hidden"
            initial={reduceMotion ? false : { x: 400 }}
            animate={{ x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { x: 400 }}
          >
            <div className="flex items-center gap-2 text-start min-w-0">
              <span className={clsx("text-4xl p-1 rounded-full shrink-0", FONT_COLOR_TYPES[activeToast.type])} aria-hidden="true">
                {ICON_TYPES[activeToast.type]}
              </span>
              <div className="flex flex-col items-start justify-center gap-2 min-w-0">
                <p className="text-xs text-zinc-400 break-words">{activeToast.body}</p>
                {activeToast.options?.actions && activeToast.options.actions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {activeToast.options.actions.map((action, index) => {
                      const actionId = action.id ?? "action-" + index
                      return (
                        <NormalButton key={actionId} variant="secondary" className="text-xs" title={action.label} ariaLabel={action.label} onClick={() => invokeAction(activeToast.id, actionId)}>
                          {action.label}
                        </NormalButton>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
            <NormalButton
              className="p-1 text-zinc-400 shrink-0"
              title={t("notifications.discard")}
              ariaLabel={t("notifications.discard")}
              variant="ghost"
              onClick={() => dismissToast(activeToast.id, "manual")}
            >
              <PiXCircleDuotone />
            </NormalButton>
            {toastDuration != null && (
              <motion.div
                data-testid="toast-timer"
                aria-hidden="true"
                className={clsx("absolute inset-x-0 bottom-0 h-0.5 origin-left", TIMER_COLOR_TYPES[activeToast.type])}
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={reduceMotion ? { duration: 0 } : { duration: toastDuration / 1000, ease: "linear" }}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default NotificationsOverlay
