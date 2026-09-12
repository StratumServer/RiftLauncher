import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { accentPresetById, ACCENT_PRESETS, DEFAULT_ACCENT_ID, isAccentColorId, normalizeAccentColorId } from "@domain/accentColors"

const HEX_PATTERN = /^#[0-9a-f]{6}$/

describe("accent presets", () => {
  it("lists between six and eight presets, the current brand color first as the default", () => {
    assert.ok(ACCENT_PRESETS.length >= 6 && ACCENT_PRESETS.length <= 8, `expected 6 to 8 presets, found ${ACCENT_PRESETS.length}`)
    assert.equal(ACCENT_PRESETS[0]?.id, DEFAULT_ACCENT_ID)
    assert.equal(ACCENT_PRESETS[0]?.hex, "#d49754")
  })

  it("gives every preset a unique id, a name and a well-formed hex", () => {
    const seen = new Set<string>()
    for (const preset of ACCENT_PRESETS) {
      assert.equal(seen.has(preset.id), false, `duplicate id ${preset.id}`)
      seen.add(preset.id)
      assert.ok(preset.name.length > 0, `${preset.id} has no name`)
      assert.match(preset.hex, HEX_PATTERN, `${preset.id} has an unusable hex: ${preset.hex}`)
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
