/**
 * The launcher's accent, as a small named palette rather than a free colour field.
 *
 * The brand ramp is three stops, not one: `--color-vsl` (light) is read as text through `text-vsl`,
 * as a fill through `bg-vsl`, and as a boundary through `border-vsl`/`outline-vsl`; `--color-vs`
 * (mid) is the Play button, the Log in button, the active sidebar item and the enabled toggle's
 * fill; `--color-vsd` (dark) is their pressed shade and the Grid selected-card fill. Picking an
 * accent moves all three together, so the Play button repaints along with the links instead of
 * staying brown under a teal accent. Each preset therefore carries its own light, mid and dark
 * stop rather than one hex.
 *
 * The light stop lands over the player's own background image everywhere it is text, and
 * tests/text-contrast.test.ts holds it to a contrast floor there. A free picker would hand that
 * guarantee to the player, who could then choose a colour unreadable on their own background. The
 * mid and dark stops instead sit under light label text as an opaque fill (the Play button among
 * them), so the same file holds them to the label's own floor there. A closed set of presets keeps
 * both guarantees: every preset here is measured against the same floors as the shipped default and
 * pinned by that file, so a preset that fails either floor cannot ship.
 *
 * See ConfigContext.tsx and accentStyle.ts for where the chosen preset is applied.
 */

export interface AccentPreset {
  readonly id: string
  readonly name: string
  /** `--color-vsl`: text, links, outlines, borders. */
  readonly light: string
  /** `--color-vs`: the Play button, the Log in button, the active sidebar item, enabled toggles. */
  readonly mid: string
  /** `--color-vsd`: the pressed shade of the mid stop, and the Grid selected-card fill. */
  readonly dark: string
}

/** The brand ramp's own three stops, unchanged, so picking it looks exactly like never picking anything. */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "amber", name: "Amber", light: "#d49754", mid: "#7e501e", dark: "#4f3110" },
  { id: "gold", name: "Gold", light: "#d7a542", mid: "#775718", dark: "#4a360c" },
  { id: "copper", name: "Copper", light: "#db9470", mid: "#924823", dark: "#5c2b13" },
  { id: "sage", name: "Sage", light: "#8dbd75", mid: "#41662f", dark: "#263f1a" },
  { id: "teal", name: "Teal", light: "#5cd6cc", mid: "#186861", dark: "#0d403c" },
  { id: "sky", name: "Sky", light: "#6cb9e0", mid: "#1b6388", dark: "#0e3d55" },
  { id: "lavender", name: "Lavender", light: "#c2abe3", mid: "#733dc1", dark: "#48237e" },
  { id: "rose", name: "Rose", light: "#d98cb3", mid: "#a1326a", dark: "#661c42" }
]

/** The first preset, and what an unreadable stored id falls back to. */
export const DEFAULT_ACCENT_ID = (ACCENT_PRESETS[0] as AccentPreset).id

const ACCENT_PRESETS_BY_ID = new Map(ACCENT_PRESETS.map((preset) => [preset.id, preset]))

/** True for any id this palette actually lists. */
export function isAccentColorId(value: unknown): value is string {
  return typeof value === "string" && ACCENT_PRESETS_BY_ID.has(value)
}

/** Anything that does not name a listed preset, missing included, becomes the shipped default. */
export function normalizeAccentColorId(value: unknown): string {
  return isAccentColorId(value) ? value : DEFAULT_ACCENT_ID
}

/** The preset an id names, or the default preset for an id this palette has dropped since it was saved. */
export function accentPresetById(id: string): AccentPreset {
  return ACCENT_PRESETS_BY_ID.get(id) ?? (ACCENT_PRESETS[0] as AccentPreset)
}
