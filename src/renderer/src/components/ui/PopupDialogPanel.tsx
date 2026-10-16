import { useEffect, useState } from "react"
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react"
import { POPUP_VARIANTS, POPUP_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"

/**
 * Headless UI's Dialog, mounted closed and opened from the first effect instead of mounted open.
 *
 * Headless UI hides the page behind a dialog (aria-hidden and inert on the top-level node that
 * holds the application) from one effect, run when the Dialog turns open. Which node that is only
 * becomes known one render after the Dialog mounts. A panel is only rendered while it is open, so
 * every dialog here mounted already open, ran that effect before the node was known, found nothing
 * to hide and never ran it again: the page stayed exposed to assistive technology (#624). The
 * first dialog of a session was the exception, because Headless UI also holds back "open" until
 * its own first effect. Opening from our own effect gives every dialog the order Headless UI is
 * written for. The state lives here and not in PopupDialogPanel so that it starts closed again
 * each time a dialog mounts.
 */
function DialogOpenedAfterMount({ onClose, className, children }: Readonly<{ onClose: (value: boolean) => void; className: string; children: React.ReactNode }>): JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => setOpen(true), [])

  return (
    <Dialog static open={open} onClose={onClose} className={className}>
      {children}
    </Dialog>
  )
}

function PopupDialogPanel({
  children,
  title,
  isOpen,
  close,
  fixedWidth = true,
  scrollBody = false,
  onExitComplete
}: Readonly<{
  children: React.ReactElement
  title: JSX.Element | string
  isOpen: boolean
  close: (value: boolean) => void
  fixedWidth?: boolean
  // Hand scrolling to the content instead of scrolling the whole panel, so a tall
  // dialog keeps its actions pinned in view on a short window.
  scrollBody?: boolean
  /** Fires once this panel has fully left the DOM, its own exit animation included. For a caller that opens another dialog right after this one closes: waiting for this instead of firing both from the same update keeps the two from ever being mounted at once. */
  onExitComplete?: () => void
}>): JSX.Element {
  return (
    <AnimatePresence onExitComplete={onExitComplete}>
      {isOpen && (
        <DialogOpenedAfterMount onClose={close} className="w-full h-full absolute top-0 left-0 z-200 flex justify-center items-center select-none bg-zinc">
          <motion.div
            variants={POPUP_WRAPPER_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            className={clsx(
              "relative w-full h-full flex flex-col justify-center items-center rounded-md bg-image-vs bg-center bg-cover",
              "before:absolute before:left-0 before:top-0 before:w-full before:h-full before:backdrop-blur-[2px] before:bg-zinc-950/70"
            )}
          >
            <motion.div
              variants={POPUP_VARIANTS}
              initial="initial"
              animate="animate"
              exit="exit"
              className={clsx(
                "relative flex flex-col justify-center items-center rounded-md p-2",
                "before:absolute before:left-0 before:top-0 before:w-full before:h-full before:rounded-md before:backdrop-blur-sm before:bg-zinc-950/40 before:shadow-sm before:shadow-zinc-950/50 before:border before:border-zinc-400/5"
              )}
            >
              <DialogPanel
                className={clsx(
                  // The viewport is the ceiling, never the size: a panel that *is* 100vw wide
                  // stops being a dialog and becomes the screen, which is what `fixedWidth={false}`
                  // (the wide mod table) turned into. Capping instead lets that case go back to
                  // sizing itself to its content while a narrow window still clamps both cases.
                  "relative flex max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg p-4 text-center backdrop-blur-x",
                  scrollBody ? "min-h-0 overflow-hidden" : "overflow-y-auto",
                  fixedWidth && "w-[40rem]"
                )}
              >
                <>
                  <DialogTitle className="text-2xl font-bold">{title}</DialogTitle>
                  {children}
                </>
              </DialogPanel>
            </motion.div>
          </motion.div>
        </DialogOpenedAfterMount>
      )}
    </AnimatePresence>
  )
}

export default PopupDialogPanel
