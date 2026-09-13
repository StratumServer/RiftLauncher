import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"

import { accentPresetById, ACCENT_PRESETS, DEFAULT_ACCENT_ID, isAccentColorId, normalizeAccentColorId } from "@domain/accentColors"

const HEX_PATTERN = /^#[0-9a-f]{6}$/

const STYLES_CSS = resolve(__dirname, "..", "..", "src", "renderer", "src", "styles.css")

/** One `--color-*` token from the shipped stylesheet's `@theme` block, read as its own hex. */
function themeHex(name: string): string {
  const found = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(readFileSync(STYLES_CSS, "utf8"))
  assert.ok(found, `no --color-${name} in styles.css, the token this test reads has moved`)
  return (found[1] as string).toLowerCase()
}

describe("accent presets", () => {
  it("lists between six and eight presets, the current brand color first as the default", () => {
    assert.ok(ACCENT_PRESETS.length >= 6 && ACCENT_PRESETS.length <= 8, `expected 6 to 8 presets, found ${ACCENT_PRESETS.length}`)
    assert.equal(ACCENT_PRESETS[0]?.id, DEFAULT_ACCENT_ID)
  })

  it("keeps Amber byte-identical to the shipped brand ramp in styles.css", () => {
    const amber = ACCENT_PRESETS[0]
    assert.equal(amber?.light, themeHex("vsl"))
    assert.equal(amber?.mid, themeHex("vs"))
    assert.equal(amber?.dark, themeHex("vsd"))
  })

  it("gives every preset a unique id, a name and three distinct, well-formed hex stops", () => {
    const seen = new Set<string>()
    for (const preset of ACCENT_PRESETS) {
      assert.equal(seen.has(preset.id), false, `duplicate id ${preset.id}`)
      seen.add(preset.id)
      assert.ok(preset.name.length > 0, `${preset.id} has no name`)

      for (const stop of [preset.light, preset.mid, preset.dark] as const) {
        assert.match(stop, HEX_PATTERN, `${preset.id} has an unusable hex: ${stop}`)
      }
      assert.equal(new Set([preset.light, preset.mid, preset.dark]).size, 3, `${preset.id}'s light, mid and dark stops should all differ`)
    }
  })
})

describe("accent ids", () => {
  it("accepts every listed preset id", () => {
    for (const preset of ACCENT_PRESETS) assert.equal(isAccentColorId(preset.id), true, preset.id)
  })

  it("refuses anything the palette does not list", () => {
    for (const value of ["#d49754", "AMBER", "", "a".repeat(65), 3, null, undefined, {}, ["amber"]]) {
      assert.equal(isAccentColorId(value), false, String(value))
    }
  })

  it("normalizes anything unusable to the shipped default", () => {
    assert.equal(normalizeAccentColorId("teal"), "teal")
    assert.equal(normalizeAccentColorId(undefined), DEFAULT_ACCENT_ID)
    assert.equal(normalizeAccentColorId("#d49754"), DEFAULT_ACCENT_ID)
  })
})

describe("accentPresetById", () => {
  it("finds every listed preset by its own id", () => {
    for (const preset of ACCENT_PRESETS) assert.deepEqual(accentPresetById(preset.id), preset)
  })

  it("falls back to the default preset for an id the palette has since dropped", () => {
    assert.deepEqual(accentPresetById("retired-preset"), ACCENT_PRESETS[0])
  })
})
