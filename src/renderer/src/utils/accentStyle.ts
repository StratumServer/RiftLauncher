import { accentPresetById, DEFAULT_ACCENT_ID } from "@domain/accentColors"

/**
 * The Tailwind theme variable behind every `text-vsl`, `bg-vsl`, `border-vsl` and `outline-vsl`
 * utility (src/renderer/src/styles.css).
 */
const ACCENT_COLOR_PROPERTY = "--color-vsl"

/**
 * Paints the chosen accent preset, or clears the override so the stylesheet's own token shows.
 *
 * Same shape as {@link applyBackground} in backgroundStyle.ts: setting the property on the root is
 * the whole of "apply an accent", since every utility above already resolves it, so nothing that
 * uses the accent needs to know a choice exists. The default preset clears the override rather
 * than repeating its hex, so it stays byte-for-byte what the stylesheet has always shipped.
 */
export function applyAccentColor(id: string): void {
  const root = document.documentElement

  if (id === DEFAULT_ACCENT_ID) {
    root.style.removeProperty(ACCENT_COLOR_PROPERTY)
    return
  }

  root.style.setProperty(ACCENT_COLOR_PROPERTY, accentPresetById(id).hex)
}
