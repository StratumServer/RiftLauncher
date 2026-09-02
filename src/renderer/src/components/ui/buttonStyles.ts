/**
 * Semantic button variants shared by regular, form, and link buttons.
 * Keep the meaning stable so a primary action looks primary everywhere in the launcher.
 */
export type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost" | "link"
export type ButtonSize = "sm" | "md" | "lg"

export const BUTTON_BASE_STYLES =
  "inline-flex items-center justify-center gap-2 rounded-sm border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-vsl focus-visible:outline-offset-2 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"

export const BUTTON_VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: "border-vsl bg-vs text-zinc-100 shadow-sm shadow-zinc-950/50 hover:bg-vs/90 active:bg-vs/80",
  secondary: "border-zinc-400/20 bg-zinc-950/40 text-zinc-200 hover:bg-zinc-800/60 active:bg-zinc-800/80",
  destructive: "border-red-600 bg-red-700 text-zinc-100 shadow-sm shadow-zinc-950/50 hover:bg-red-600 active:bg-red-800",
  ghost: "border-transparent bg-transparent text-zinc-200 hover:bg-zinc-800/40 active:bg-zinc-800/60",
  link: "border-transparent bg-transparent text-vsl underline hover:text-zinc-200 active:text-zinc-100"
}

export const BUTTON_SIZE_STYLES: Record<ButtonSize, string> = {
  sm: "min-h-8 min-w-8 px-2 py-1",
  md: "min-h-11 px-4 py-2",
  lg: "min-h-12 px-5 py-3"
}

export const BUTTON_FOCUS_STYLES = "focus-visible:outline-2 focus-visible:outline-vsl focus-visible:outline-offset-2"

export const BUTTON_GROUP_EQUAL_WIDTH_STYLES = "w-full flex-col sm:flex-row [&>*]:w-full [&>*]:min-w-0 [&>*]:flex-1 sm:[&>*]:w-auto"

export const MENU_TRIGGER_STYLES = `${BUTTON_BASE_STYLES} ${BUTTON_SIZE_STYLES.sm} w-full overflow-hidden ${BUTTON_VARIANT_STYLES.secondary}`

export const MENU_OPTION_STYLES =
  "w-full min-h-10 shrink-0 flex items-center gap-2 px-2 py-2 overflow-hidden cursor-pointer text-start transition-colors duration-150 hover:bg-zinc-700/50 focus-visible:outline-2 focus-visible:outline-vsl focus-visible:outline-offset-[-2px]"
