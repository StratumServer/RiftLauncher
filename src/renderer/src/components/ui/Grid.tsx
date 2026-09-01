import { selectableItemProps } from "@renderer/components/ui/selectableItemProps"
import { GRIDGROUP_VARIANTS, GRIDITEM_VARIANTS } from "@renderer/utils/animateVariants"
import clsx from "clsx"
import { AnimatePresence, motion, useInView } from "motion/react"
import { useRef } from "react"

/**
 * Grid external wrapper.
 *
 * @param {object} props - The component props.
 * @param {React.ReactNode} props.children - The content to be wrapped.
 * @param {string} [props.className] - Additional class names for styling.
 * @returns {JSX.Element} A JSX element wrapping the children with specified styles.
 */
export function GridWrapper({ children, className }: Readonly<{ children: React.ReactNode; className?: string }>): JSX.Element {
  return (
    <div
      className={clsx(
        "relative mx-auto flex flex-col rounded-md p-2",
        "before:absolute before:left-0 before:top-0 before:w-full before:h-full before:rounded-md before:backdrop-blur-sm before:bg-zinc-950/40 before:shadow-sm before:shadow-zinc-950/50 before:border before:border-zinc-400/5",
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * Grid group. An ul html element with styles.
 *
 * @param {object} props - The component props.
 * @param {React.ReactNode} props.children - The content to be wrapped.
 * @param {string} [props.className] - Additional class names for styling.
 * @returns {JSX.Element} A JSX element wrapping the children with specified styles.
 */
export function GridGroup({ children, className }: Readonly<{ children: React.ReactNode; className?: string }>): JSX.Element {
  return (
    <motion.ul variants={GRIDGROUP_VARIANTS} initial="initial" animate="animate" exit="exit" className={clsx("relative w-full flex flex-row flex-wrap justify-center gap-4", className)}>
      <AnimatePresence>{children}</AnimatePresence>
    </motion.ul>
  )
}

/**
 * Grid item. A li html element with styles. Set the basis-x and max-w-x with the size prop.
 *
 * @param {object} props - The component props.
 * @param {React.ReactNode} props.children - The content to be wrapped.
 * @param {boolean} props.selected - If the item is selected.
 * @param {string} [props.className] - Additional class names for styling.
 * @param {string} [props.size] - Like the className prop but for the size properties.
 * @param {() => void} [props.onClick] - The function to be called when the item is clicked.
 * @param {boolean} [props.pressed] - Whether activation changes the announced pressed state.
 * @param {string} [props.ariaLabel] - Accessible name for the item when it is clickable. Give it
 *   when the visible content does not already read as a short label (a mod card names the mod).
 * @returns {JSX.Element} A JSX element wrapping the children with specified styles.
 */
export function GridItem({
  children,
  className,
  selected = false,
  size,
  onClick,
  pressed,
  ariaLabel
}: Readonly<{
  children: React.ReactNode
  className?: string
  selected?: boolean
  size?: string
  onClick?: () => void
  pressed?: boolean
  ariaLabel?: string
}>): JSX.Element {
  const ref = useRef(null)
  // once: true, not the useInView default of false. With false, motion/react's inView()
  // never unobserves the card (see node_modules/motion's render/dom/viewport/index.mjs):
  // the IntersectionObserver it creates per card stays live for the card's whole lifetime,
  // firing on every single scroll past it and replaying the entrance fade each time. A card
  // that's already been seen once doesn't need to keep being watched, and repeatedly
  // re-fading in content the user has already scrolled past isn't a look anything here asks
  // for on purpose, it's just what the hook's default happens to do.
  const isInView = useInView(ref, {
    once: true
  })

  return (
    <motion.li ref={ref} variants={GRIDITEM_VARIANTS} className={clsx("grow shrink-0 rounded-sm", size)}>
      <motion.div
        initial="initial"
        animate={isInView ? "animate" : "initial"}
        exit="exit"
        className={clsx(
          "w-full h-full rounded-sm backdrop-blur-xs border cursor-pointer shadow-sm shadow-zinc-950/50 hover:shadow-none duration-200",
          // Full opacity, not the /25 this used to carry: the fill and panel behind it are dark
          // enough that a translucent border barely separated from them (issue #258, 1.53:1 worst
          // case against the 3:1 WCAG 1.4.11 floor for a boundary that is the sole selected-state
          // cue). Opaque clears it with room to spare; see text-contrast.test.ts.
          selected ? "bg-vsd/50 border-vsl" : "bg-zinc-950/50 border-zinc-400/5",
          onClick && "cursor-pointer",
          onClick && "focus-visible:outline-2 focus-visible:outline-vsl focus-visible:outline-offset-2",
          className
        )}
        {...selectableItemProps({ onClick, pressed, label: ariaLabel })}
      >
        {children}
      </motion.div>
    </motion.li>
  )
}
