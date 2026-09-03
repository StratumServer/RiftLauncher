import { Button as HButton } from "@headlessui/react"
import clsx from "clsx"
import { Link } from "react-router-dom"

import {
  BUTTON_BASE_STYLES,
  BUTTON_GROUP_EQUAL_WIDTH_STYLES,
  BUTTON_LINK_SIZE_STYLES,
  BUTTON_SIZE_STYLES,
  BUTTON_VARIANT_STYLES,
  type ButtonSize,
  type ButtonVariant
} from "@renderer/components/ui/buttonStyles"
import { renderActionContent, useActionBusy } from "@renderer/components/ui/actionContent"

/**
 * A ButtonsWrapper must contain a FormButton or a FormLinkButton.
 * Used to group more than one Buttons. Not needed if only using one Button.
 *
 * @param {object} props - The component props.
 * @param {React.ReactNode} props.children - The content to be wrapped.
 * @param {string} props.className - Additional class names for styling.
 * @param {boolean} [props.bgDark] - Add or not the darker background.
 * @param {boolean} [props.equalWidth] - Give direct action children equal responsive widths.
 * @param {boolean} [props.flush] - Remove the group's inner inset so actions align with adjacent content.
 * @returns {JSX.Element} A JSX element wrapping the children with specified styles.
 */
export function ButtonsWrapper({
  children,
  className,
  bgDark = true,
  equalWidth = false,
  flush = false
}: Readonly<{ children: React.ReactNode; className?: string; bgDark?: boolean; equalWidth?: boolean; flush?: boolean }>): JSX.Element {
  return (
    <div
      className={clsx(
        "relative w-fit",
        equalWidth && "w-full",
        bgDark &&
          "before:absolute before:left-0 before:top-0 before:w-full before:h-full before:rounded-md before:backdrop-blur-sm before:bg-zinc-950/15 before:shadow-sm before:shadow-zinc-950/50 before:border before:border-zinc-400/5",
        className
      )}
    >
      <div className={clsx("relative flex gap-4 justify-center items-center", flush ? "p-0" : "p-2", equalWidth && BUTTON_GROUP_EQUAL_WIDTH_STYLES, className)}>{children}</div>
    </div>
  )
}

/**
 * Regular button.
 *
 * @param {object} props - The component props.
 * @param {React.ReactNode} props.children - The content to be wrapped.
 * @param {string} props.className - Additional class names for styling.
 * @param {() => void} props.onClick - The function to be called when the button is clicked.
 * @param {string} props.title - The title and content of the button.
 * @param {boolean} props.disabled - If the button is dissabled or not.
 * @param {boolean} [props.equalWidth] - Give direct action children equal responsive widths.
 * @param {string} [props.variant] - Semantic action variant: "primary" || "secondary" || "destructive" || "ghost" || "link".
 * @returns {JSX.Element} A JSX element wrapping the children with specified styles.
 */
export function FormButton({
  children,
  icon,
  className,
  onClick,
  title,
  disabled,
  busy,
  variant = "secondary",
  size = "sm",
  nativeType = "button",
  ariaLabel,
  ariaPressed
}: Readonly<{
  children?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<unknown>
  title: string
  disabled?: boolean
  busy?: boolean
  variant?: ButtonVariant
  size?: ButtonSize
  nativeType?: "button" | "submit" | "reset"
  ariaLabel?: string
  ariaPressed?: boolean
}>): JSX.Element {
  const action = useActionBusy(onClick, busy, disabled)

  return (
    <HButton
      type={nativeType}
      disabled={disabled || action.busy}
      onClick={action.onClick}
      title={!disabled ? title : ""}
      aria-label={ariaLabel ?? title}
      aria-busy={action.busy}
      aria-pressed={ariaPressed}
      className={clsx(BUTTON_BASE_STYLES, variant === "link" ? BUTTON_LINK_SIZE_STYLES : BUTTON_SIZE_STYLES[size], "overflow-hidden", BUTTON_VARIANT_STYLES[variant], className)}
    >
      {renderActionContent(children, icon, title, action.busy)}
    </HButton>
  )
}

/**
 * Link to a page with the same styles as the FormButton.
 *
 * @param {object} props - The component props.
 * @param {React.ReactNode} props.children - The content to be wrapped.
 * @param {string} props.className - Additional class names for styling.
 * @param {string} props.to - Route to the page.
 * @param {string} props.title - The title and content of the button.
 * @param {string} [props.variant] - Semantic action variant.
 * @param {string} [props.size] - Control size: "sm" || "md" || "lg".
 * @returns {JSX.Element} A JSX element wrapping the children with specified styles.
 */
export function FormLinkButton({
  children,
  icon,
  className,
  to,
  title,
  variant = "secondary",
  size = "sm"
}: Readonly<{
  children?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  to: string
  title: string
  variant?: ButtonVariant
  size?: ButtonSize
}>): JSX.Element {
  return (
    <Link
      to={to}
      title={title}
      className={clsx(BUTTON_BASE_STYLES, variant === "link" ? BUTTON_LINK_SIZE_STYLES : BUTTON_SIZE_STYLES[size], "overflow-hidden", BUTTON_VARIANT_STYLES[variant], className)}
    >
      {renderActionContent(children, icon, title)}
    </Link>
  )
}
