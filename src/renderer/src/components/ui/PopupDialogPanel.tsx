import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react"
import { POPUP_VARIANTS, POPUP_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"

function PopupDialogPanel({
  children,
  title,
  isOpen,
  close,
  fixedWidth = true
}: Readonly<{
  children: React.ReactElement
  title: JSX.Element | string
  isOpen: boolean
  close: (value: boolean) => void
  fixedWidth?: boolean
}>): JSX.Element {
  return (
    <AnimatePresence>
      {isOpen && (
        <Dialog static open={isOpen} onClose={close} className="w-full h-full absolute top-0 left-0 z-200 flex justify-center items-center select-none bg-zinc">
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
                  "relative flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] flex-col gap-4 overflow-y-auto rounded-lg p-4 text-center backdrop-blur-x sm:p-6",
                  fixedWidth && "max-w-[40rem]"
                )}
              >
                <>
                  <DialogTitle className="text-2xl font-bold">{title}</DialogTitle>
                  {children}
                </>
              </DialogPanel>
            </motion.div>
          </motion.div>
        </Dialog>
      )}
    </AnimatePresence>
  )
}

export default PopupDialogPanel
