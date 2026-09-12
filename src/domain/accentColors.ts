/**
 * The launcher's accent, as a small named palette rather than a free colour field.
 *
 * `--color-vsl` (styles.css) is read as text through `text-vsl`, as a fill through `bg-vsl`, as a
 * boundary through `border-vsl` and `outline-vsl`, and it lands over the player's own background
 * image on every one of those surfaces. tests/text-contrast.test.ts holds every surface it lands
 * on to a contrast floor, and a free picker would hand that guarantee to the player, who could
 * then choose a colour unreadable on their own background. A closed set of presets keeps the
 * guarantee instead: every preset here is measured against the same floors as the shipped default
 * and pinned by that file, so a preset that fails the floor cannot ship.
 *
 * `--color-vs` and `--color-vsd`, the two other stops on the brand ramp, are not part of this: they
 * carry light text on top rather than being text themselves (the Play button's fill among them),
 * and stay fixed whatever accent is picked. See ConfigContext.tsx and accentStyle.ts for where the
 * chosen preset is applied.
 */

export interface AccentPreset {
  readonly id: string
  readonly name: string
  readonly hex: string
}

/** The brand ramp's own light stop, unchanged, so picking it looks exactly like never picking anything. */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "amber", name: "Amber", hex: "#d49754" },
  { id: "gold", name: "Gold", hex: "#d7a542" },
  { id: "copper", name: "Copper", hex: "#db9470" },
  { id: "sage", name: "Sage", hex: "#8dbd75" },
  { id: "teal", name: "Teal", hex: "#5cd6cc" },
  { id: "sky", name: "Sky", hex: "#6cb9e0" },
  { id: "lavender", name: "Lavender", hex: "#c2abe3" },
  { id: "rose", name: "Rose", hex: "#d98cb3" }
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
