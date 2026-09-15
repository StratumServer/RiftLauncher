import { Button as HButton } from "@headlessui/react"
import clsx from "clsx"
import { forwardRef } from "react"
import { Link } from "react-router-dom"

import { BUTTON_BASE_STYLES, BUTTON_LINK_SIZE_STYLES, BUTTON_SIZE_STYLES, BUTTON_VARIANT_STYLES, type ButtonSize, type ButtonVariant } from "@renderer/components/ui/buttonStyles"
import { renderActionContent, useActionBusy } from "@renderer/components/ui/actionContent"

/**
 * Shared body behind NormalButton here and FormButton (FormComponents/FormButtons.tsx): a
 * HeadlessUI Button styled off the semantic variant/size scale, with the busy-while-pending and
 * icon+label rendering both share. `overflowHidden` and `variant`/`size` having no default here is
 * what keeps this a shared body rather than a fifth public preset: every caller goes through
 * NormalButton or FormButton, which is where a default belongs to a specific look, not to the
 * plumbing underneath both.
 */
export type ButtonProps = Readonly<{
  children?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  /** Escape hatch for the rare control whose colour is data, not variant: an accent swatch, a progress fill. */
  style?: React.CSSProperties
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<unknown>
  title: string
  ariaLabel?: string
  disabled?: boolean
  busy?: boolean
  nativeType?: "button" | "submit" | "reset"
  variant: ButtonVariant
  size: ButtonSize
  ariaPressed?: boolean
  /** For a disclosure control (a toggle that shows or hides another element), not a stateful one. Only FormButton's callers use this. */
  ariaExpanded?: boolean
  /** FormButton and FormLinkButton always pass this; NormalButton and LinkButton never do. */
  overflowHidden?: boolean
}> &
  /*
   * Everything else (role, id, tabIndex, aria-labelledby, the hover/focus tracking handlers, the
   * data-* state attributes) passed straight to the underlying button. A MenuItem rendered
   * `as={Fragment}` clones its single child and merges exactly these onto it, expecting them to
   * land on the real DOM node; a component with no rest slot to catch them would silently drop
   * every one, leaving the button with none of the roving-focus wiring Headless UI thinks it set.
   */
  Readonly<Omit<React.ComponentPropsWithoutRef<"button">, "onClick" | "disabled" | "title" | "className" | "children" | "type">>

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, icon, className, style, onClick, title, ariaLabel, disabled, busy, nativeType = "button", variant, size, ariaPressed, ariaExpanded, overflowHidden, ...rest },
  ref
) {
  const action = useActionBusy(onClick, busy, disabled)

  return (
    <HButton
      {...rest}
      ref={ref}
      type={nativeType}
      disabled={disabled || action.busy}
      onClick={action.onClick}
      title={!disabled ? title : ""}
      aria-label={ariaLabel ?? title}
      aria-busy={action.busy}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      style={style}
      className={clsx(BUTTON_BASE_STYLES, variant === "link" ? BUTTON_LINK_SIZE_STYLES : BUTTON_SIZE_STYLES[size], overflowHidden && "overflow-hidden", BUTTON_VARIANT_STYLES[variant], className)}
    >
      {renderActionContent(children, icon, title, action.busy)}
    </HButton>
  )
})

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
type NormalButtonProps = Readonly<{
  children?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  style?: React.CSSProperties
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<unknown>
  title: string
  ariaLabel?: string
  disabled?: boolean
  busy?: boolean
  nativeType?: "button" | "submit" | "reset"
  variant?: ButtonVariant
  size?: ButtonSize
  ariaPressed?: boolean
}> &
  Readonly<Omit<React.ComponentPropsWithoutRef<"button">, "onClick" | "disabled" | "title" | "className" | "children" | "type">>

export const NormalButton = forwardRef<HTMLButtonElement, NormalButtonProps>(function NormalButton({ variant = "ghost", size = "sm", ...props }, ref) {
  return <Button ref={ref} variant={variant} size={size} {...props} />
})

export type ButtonLinkProps = Readonly<{
  children?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  to: string
  title: string
  ariaLabel?: string
  variant: ButtonVariant
  size: ButtonSize
  overflowHidden?: boolean
}>

export function ButtonLink({ children, icon, className, to, title, ariaLabel, variant, size, overflowHidden }: ButtonLinkProps): JSX.Element {
  return (
    <Link
      to={to}
      title={title}
      aria-label={ariaLabel}
      className={clsx(BUTTON_BASE_STYLES, variant === "link" ? BUTTON_LINK_SIZE_STYLES : BUTTON_SIZE_STYLES[size], overflowHidden && "overflow-hidden", BUTTON_VARIANT_STYLES[variant], className)}
    >
      {renderActionContent(children, icon, title)}
    </Link>
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
    <ButtonLink icon={icon} className={className} to={to} title={title} ariaLabel={ariaLabel ?? title} variant={variant} size={size}>
      {children}
    </ButtonLink>
  )
}
