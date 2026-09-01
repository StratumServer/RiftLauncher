import type { KeyboardEvent } from "react"

/** Just the props this helper sets, kept narrow so it spreads cleanly onto a motion element. */
type SelectableItemProps = {
  role?: "button"
  tabIndex?: number
  "aria-pressed"?: boolean
  "aria-disabled"?: true
  "aria-label"?: string
  onClick?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}

/**
 * The ARIA and keyboard wiring a clickable list or grid item needs so assistive
 * tech can announce it and a keyboard can activate it.
 *
 * `GridItem` and `TableBodyRow` both render a `motion.li` with an `onClick` and
 * a `selected` flag that, before this, only drove a border colour. A screen
 * reader saw a plain list item: no name for the action, no hint that one item
 * in the set is the chosen one, and Tab skipped straight past it (issue #263,
 * WCAG 1.3.1 and 4.1.2). `BackgroundTile` on the config page already solved the
 * same problem with `aria-pressed` on a real button; this puts the equivalent
 * on an interactive descendant of the two shared list primitives, keeping the
 * `li` as a list item.
 *
 * A non-interactive item (no `onClick`) gets nothing back: it stays a plain
 * `li`, which is correct for the read-only data tables that also use these
 * primitives.
 */
export function selectableItemProps({ onClick, pressed, disabled = false, label }: { onClick?: () => void; pressed?: boolean; disabled?: boolean; label?: string }): SelectableItemProps {
  if (!onClick) return {}

  return {
    role: "button",
    // A disabled row stays in the reading order and keeps announcing its state,
    // it just drops out of the Tab sequence and off the activation path.
    tabIndex: disabled ? -1 : 0,
    ...(pressed === undefined ? {} : { "aria-pressed": pressed }),
    "aria-disabled": disabled || undefined,
    "aria-label": label,
    onClick: disabled ? undefined : onClick,
    onKeyDown: disabled
      ? undefined
      : (event): void => {
          // Only the item itself, never a click bubbling up from a button nested
          // inside it (the favourite and ModDB actions on a mod card).
          if (event.target !== event.currentTarget) return
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          onClick()
        }
  }
}
