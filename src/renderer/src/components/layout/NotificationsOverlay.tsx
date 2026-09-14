import { useCallback, useEffect, useRef } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { PiInfoDuotone, PiWarningDuotone, PiCheckCircleDuotone, PiProhibitInsetDuotone, PiXCircleDuotone } from "react-icons/pi"
import { useTranslation } from "react-i18next"
import clsx from "clsx"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { NormalButton } from "../ui/Buttons"

// red-700 read 2.34:1 on the toast scrim over a bright background image, under the 3:1 an icon that
// carries a meaning of its own needs. red-400 is the nearest shade that clears it. See
// tests/text-contrast.test.ts, which pins all four.
const FONT_COLOR_TYPES = { success: "text-lime-600", info: "text-vsl", error: "text-red-400", warning: "text-yellow-400" }
const TIMER_COLOR_TYPES = { success: "bg-lime-600", info: "bg-vs", error: "bg-red-400", warning: "bg-yellow-400" }
const ICON_TYPES = { success: <PiCheckCircleDuotone />, info: <PiInfoDuotone />, error: <PiProhibitInsetDuotone />, warning: <PiWarningDuotone /> }

/** The id of the banner an element sits in, or null for anything outside the stack. */
function toastIdAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest("[data-toast-id]")?.getAttribute("data-toast-id") ?? null
}

function NotificationsOverlay(): JSX.Element {
  const { t } = useTranslation()
  const { activeToasts, dismissToast, invokeAction, setPausedToasts } = useNotificationsContext()
  const reduceMotion = useReducedMotion()
  const regionRef = useRef<HTMLDivElement>(null)
  // Which banner the pointer is over, not merely whether it is in the region:
  // each banner runs its own countdown, so reading one must not hold the two
  // beside it.
  const pointerInside = useRef(false)
  const pointerToastId = useRef<string | null>(null)
  const focusedToastId = useRef<string | null>(null)
  const toastIds = useRef<readonly string[]>([])
  toastIds.current = activeToasts.map((entry) => entry.record.id)
  const stackKey = toastIds.current.join(",")

  /** The banner focus is actually in right now, read off the document rather than off an event. */
  const focusedToastIdNow = useCallback((): string | null => (regionRef.current?.contains(document.activeElement) ? toastIdAt(document.activeElement) : null), [])

  const reconcilePause = useCallback((): void => {
    if (!regionRef.current) return

    const ids = toastIds.current
    // A banner the pointer was over can be dismissed under it, and no mouseover
    // fires for a pointer that never moved (#398). The banner that slides into
    // that place is then unknown, so the whole stack is held until the pointer
    // moves and names one again: better a banner that waits than one pulled out
    // from under someone reading it.
    const heldByPointer = pointerToastId.current !== null && ids.includes(pointerToastId.current) ? [pointerToastId.current] : pointerInside.current ? ids : []
    const heldByFocus = focusedToastId.current !== null && ids.includes(focusedToastId.current) ? [focusedToastId.current] : []
    setPausedToasts([...new Set([...heldByPointer, ...heldByFocus])])
  }, [setPausedToasts])

  useEffect(() => {
    let disposed = false
    let queued = false

    const scheduleReconcile = (): void => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!disposed) reconcilePause()
      })
    }
    const handleMouseOver = (event: MouseEvent): void => {
      pointerInside.current = regionRef.current?.contains(event.target as Node | null) ?? false
      pointerToastId.current = pointerInside.current ? toastIdAt(event.target) : null
      scheduleReconcile()
    }
    const handleFocusChange = (): void => {
      focusedToastId.current = focusedToastIdNow()
      scheduleReconcile()
    }

    document.addEventListener("mouseover", handleMouseOver, true)
    document.addEventListener("focusin", handleFocusChange, true)
    document.addEventListener("focusout", handleFocusChange, true)
    reconcilePause()

    return (): void => {
      disposed = true
      document.removeEventListener("mouseover", handleMouseOver, true)
      document.removeEventListener("focusin", handleFocusChange, true)
      document.removeEventListener("focusout", handleFocusChange, true)
    }
  }, [stackKey, reconcilePause, focusedToastIdNow])

  const handleMouseEnter = (event: React.MouseEvent): void => {
    pointerInside.current = true
    pointerToastId.current = toastIdAt(event.target)
    reconcilePause()
  }
  const handleMouseLeave = (): void => {
    pointerInside.current = false
    pointerToastId.current = null
    reconcilePause()
  }
  // Taken from the event, not from document.activeElement: a control can raise a focus event
  // before the document agrees, and the banner it belongs to is what has to stop counting down.
  const handleFocusCapture = (event: React.FocusEvent): void => {
    focusedToastId.current = toastIdAt(event.target)
    reconcilePause()
  }
  const handleBlurCapture = (): void =>
    queueMicrotask(() => {
      focusedToastId.current = focusedToastIdNow()
      reconcilePause()
    })

  const releaseFocusAndReconcile = (): void => {
    const region = regionRef.current
    if (region?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
    focusedToastId.current = focusedToastIdNow()
    reconcilePause()
  }

  return (
    // Always-mounted polite live region: a queued toast inserted here minutes
    // later is still announced. A freshly mounted role="status" node is not.
    //
    // The pause handlers live here, on the region, not on the banner. A banner
    // is keyed on its record id, so a hand-off is a brand new element: with the
    // handlers on it, a banner that takes a freed place under a pointer that
    // never moved got no mouseenter and ran its timer while visibly hovered
    // (#398). The region does not change identity across a hand-off, so the
    // pointer's last known banner carries over. Which banner it names is
    // re-read on every move, so the two beside the one being read keep running.
    //
    // A player reading a long message, or tabbing to the answer buttons, must
    // not have the banner pulled out from under them. Leaving it restarts the
    // full turn rather than resuming what was left of it: the point is to give
    // back the reading time, not to hand back two hundred milliseconds of it.
    //
    // Bottom right, and transparent to the pointer. Top right put the region
    // straight over the right-hand end of every page's sticky menu, and the
    // region is painted whether or not it holds a banner, so "Select Mods to
    // install together" and "Go to top" swallowed every click at both window
    // sizes. A banner carrying actions never times out, so those controls
    // stayed dead until the player discarded it. Every persistent control in
    // this app sits at the top of its column or in the left sidebar, so the
    // bottom of the main area is the one strip a banner can take without
    // covering something a player has to reach. pointer-events-none here with
    // pointer-events-auto on each banner keeps even that strip live when the
    // region is empty, which it is most of the time.
    //
    // Oldest first in a column, so the newest arrival is the one at the bottom,
    // nearest the corner the eye is already on, and the ones above it do not
    // jump down the screen as the stack drains.
    <div
      ref={regionRef}
      role="status"
      aria-live="polite"
      aria-atomic="false"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      className="w-[20rem] h-fit absolute flex flex-col items-end bottom-2 right-2 z-800 gap-2 pointer-events-none"
    >
      <AnimatePresence>
        {activeToasts.map(({ record, turn, paused }) => (
          <motion.div
            key={record.id}
            data-toast-id={record.id}
            // Errors keep their own assertive region, which does announce on
            // insertion; everything else is announced by the polite parent.
            role={record.type === "error" ? "alert" : undefined}
            className="pointer-events-auto relative w-full flex items-center justify-between gap-2 p-2 rounded-sm text-center bg-zinc-950/60 backdrop-blur-sm overflow-hidden"
            initial={reduceMotion ? false : { x: 400 }}
            animate={{ x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { x: 400 }}
          >
            <div className="flex items-center gap-2 text-start min-w-0">
              <span className={clsx("text-4xl p-1 rounded-full shrink-0", FONT_COLOR_TYPES[record.type])} aria-hidden="true">
                {ICON_TYPES[record.type]}
              </span>
              <div className="flex flex-col items-start justify-center gap-2 min-w-0">
                <p className="text-xs text-zinc-400 break-words">{record.body}</p>
                {record.options?.actions && record.options.actions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {record.options.actions.map((action, index) => {
                      const actionId = action.id ?? "action-" + index
                      return (
                        <NormalButton
                          key={actionId}
                          variant="secondary"
                          className="text-xs"
                          title={action.label}
                          ariaLabel={action.label}
                          onClick={() => {
                            releaseFocusAndReconcile()
                            invokeAction(record.id, actionId)
                          }}
                        >
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
              onClick={() => {
                releaseFocusAndReconcile()
                dismissToast(record.id, "manual")
              }}
            >
              <PiXCircleDuotone />
            </NormalButton>
            {turn != null && (
              <motion.div
                key={turn}
                data-testid="toast-timer"
                aria-hidden="true"
                className={clsx("absolute inset-x-0 bottom-0 h-0.5 origin-left", TIMER_COLOR_TYPES[record.type])}
                // Paused snaps the bar back to full with no animation, and resuming runs the whole
                // length again. That is not a cosmetic choice: it is what the timer itself does.
                initial={{ scaleX: 1 }}
                animate={{ scaleX: paused ? 1 : 0 }}
                transition={reduceMotion || paused ? { duration: 0 } : { duration: turn / 1000, ease: "linear" }}
              />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export default NotificationsOverlay
