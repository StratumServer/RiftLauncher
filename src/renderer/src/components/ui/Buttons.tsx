import { Button as HButton } from "@headlessui/react"
import clsx from "clsx"
import { Link } from "react-router-dom"

import { BUTTON_BASE_STYLES, BUTTON_LINK_SIZE_STYLES, BUTTON_SIZE_STYLES, BUTTON_VARIANT_STYLES, type ButtonSize, type ButtonVariant } from "@renderer/components/ui/buttonStyles"
import { renderActionContent, useActionBusy } from "@renderer/components/ui/actionContent"

/**
 * Compact button for utility actions. Use a semantic variant when the action
 * is part of a larger action hierarchy; ghost is the safe default for tools.
 *
 * @param {object} props - The component props.
 * @param {React.ReactNode} props.children - The content to be wrapped.
 * @param {string} props.className - Additional class names for styling.
 * @param {() => void} props.onClick - The function to be called when the button is clicked.
 * @param {string} props.title - The title and content of the button.
 * @param {string} [props.ariaLabel] - Accessible label; falls back to title.
 * @param {boolean} props.disabled - If the button is disabled or not.
 * @param {string} [props.nativeType] - Native button type; defaults to "button".
 * @param {string} [props.variant] - Semantic action variant.
 * @param {string} [props.size] - Control size: "sm" || "md" || "lg".
 * @param {boolean} [props.ariaPressed] - Toggle state for toggle buttons.
 * @returns {JSX.Element} A JSX element wrapping the children with specified styles.
 */
export function NormalButton({
  children,
  icon,
  className,
  onClick,
  title,
  ariaLabel,
  disabled,
  busy,
  nativeType = "button",
  variant = "ghost",
  size = "sm",
  ariaPressed
}: Readonly<{
  children?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<unknown>
  title: string
  ariaLabel?: string
  disabled?: boolean
  busy?: boolean
  nativeType?: "button" | "submit" | "reset"
  variant?: ButtonVariant
  size?: ButtonSize
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
      className={clsx(BUTTON_BASE_STYLES, variant === "link" ? BUTTON_LINK_SIZE_STYLES : BUTTON_SIZE_STYLES[size], BUTTON_VARIANT_STYLES[variant], className)}
    >
      {renderActionContent(children, icon, title, action.busy)}
    </HButton>
  )
}

/**
 * Link to a page with the same styles as the Button.
 *
 * @param {object} props - The component props.
 * @param {React.ReactNode} props.children - The content to be wrapped.
 * @param {string} props.className - Additional class names for styling.
 * @param {string} props.to - Route to the page.
 * @param {string} props.title - The title and content of the button.
 * @param {string} [props.ariaLabel] - Accessible label; falls back to title.
 * @param {string} [props.variant] - Semantic action variant.
 * @param {string} [props.size] - Control size: "sm" || "md" || "lg".
 * @returns {JSX.Element} A JSX element wrapping the children with specified styles.
 */
export function LinkButton({
  children,
  icon,
  className,
  to,
  title,
  ariaLabel,
  variant = "ghost",
  size = "sm"
}: Readonly<{
  children?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  to: string
  title: string
  ariaLabel?: string
  variant?: ButtonVariant
  size?: ButtonSize
}>): JSX.Element {
  return (
    <Link
      to={to}
      title={title}
      aria-label={ariaLabel ?? title}
      className={clsx(BUTTON_BASE_STYLES, variant === "link" ? BUTTON_LINK_SIZE_STYLES : BUTTON_SIZE_STYLES[size], BUTTON_VARIANT_STYLES[variant], className)}
    >
      {renderActionContent(children, icon, title)}
    </Link>
  )
}
