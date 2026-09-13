import { accentPresetById, DEFAULT_ACCENT_ID } from "@domain/accentColors"

/**
 * The three Tailwind theme variables behind the brand ramp (src/renderer/src/styles.css):
 * `--color-vsl` (`text-vsl`, `bg-vsl`, `border-vsl`, `outline-vsl`), `--color-vs` (the Play
 * button, the Log in button, the active sidebar item, enabled toggles) and `--color-vsd` (their
 * pressed shade, and the Grid selected-card fill).
 */
const ACCENT_COLOR_PROPERTIES = {
  light: "--color-vsl",
  mid: "--color-vs",
  dark: "--color-vsd"
} as const

/**
 * Paints the chosen accent preset's three stops, or clears the overrides so the stylesheet's own
 * tokens show.
 *
 * Same shape as {@link applyBackground} in backgroundStyle.ts: setting the properties on the root
 * is the whole of "apply an accent", since every utility above already resolves them, so nothing
 * that uses the accent needs to know a choice exists. All three move together, never one alone,
 * or a fill like the Play button would keep the old brand colour under a new accent. The default
 * preset clears the overrides rather than repeating its hexes, so it stays byte-for-byte what the
 * stylesheet has always shipped.
 */
export function applyAccentColor(id: string): void {
  const root = document.documentElement

  if (id === DEFAULT_ACCENT_ID) {
    for (const property of Object.values(ACCENT_COLOR_PROPERTIES)) root.style.removeProperty(property)
    return
  }

  const preset = accentPresetById(id)
  root.style.setProperty(ACCENT_COLOR_PROPERTIES.light, preset.light)
  root.style.setProperty(ACCENT_COLOR_PROPERTIES.mid, preset.mid)
  root.style.setProperty(ACCENT_COLOR_PROPERTIES.dark, preset.dark)
}
