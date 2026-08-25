import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * The launcher paints every page over a background image the player chooses, and since #207 that
 * image can be anything they own, a white photograph included. Nothing behind the text is opaque:
 * what a reader actually gets is the text colour against a stack of translucent zinc-950 scrims
 * composited over an image nobody controls. So the only honest way to check readability is the
 * worst case, which is the image being pure white under light text and pure black under dark text.
 *
 * These tests read every value this readability pass touched straight out of the components, both
 * the scrims and the text colours, and redo that arithmetic. Text can carry its own alpha, so the
 * foreground is composited too before the ratio is taken: a translucent grey on a translucent
 * scrim is mostly the scrim, which is exactly how placeholders ended up invisible.
 *
 * WCAG AA is the bar: 4.5:1 for body text, 3:1 for large headings and for the icons that carry an
 * interactive control on their own.
 */

const RENDERER = resolve(__dirname, "..", "src", "renderer", "src")

const TEXT_FLOOR = 4.5
const NON_TEXT_FLOOR = 3

type Rgb = readonly [number, number, number]
/** A painted layer: its colour and the alpha it is painted at. */
type Layer = readonly [Rgb, number]

/** Tailwind's zinc ramp in sRGB. The scrims and every piece of low-emphasis text come from here. */
const ZINC = {
  "zinc-200": [228, 228, 231],
  "zinc-300": [212, 212, 216],
  "zinc-400": [161, 161, 170],
  "zinc-500": [113, 113, 122],
  "zinc-600": [82, 82, 91],
  "zinc-800": [39, 39, 42],
  "zinc-950": [9, 9, 11]
} as const satisfies Record<string, Rgb>

const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]

function read(file: string): string {
  return readFileSync(resolve(RENDERER, file), "utf8")
}

function match(file: string, anchor: RegExp): RegExpExecArray {
  const found = anchor.exec(read(file))
  assert.ok(found, `nothing matching ${anchor} in ${file}, the class this test pins has moved or gone`)
  return found
}

function zinc(name: string, where: string): Rgb {
  const color: Rgb | undefined = (ZINC as Record<string, Rgb | undefined>)[name]
  assert.ok(color, `${where} uses ${name}, which this test has no sRGB value for`)
  return color
}

/** One `bg-zinc-950/NN` scrim, found by the classes it sits between. */
function scrim(file: string, anchor: RegExp): Layer {
  return [ZINC["zinc-950"], Number(match(file, anchor)[1]) / 100]
}

/** One `text-zinc-NNN` or `text-zinc-NNN/AA` foreground, read where it actually ships. */
function foreground(file: string, anchor: RegExp): Layer {
  const found = match(file, anchor)
  const name = found[1]
  assert.ok(name, `${anchor} in ${file} no longer captures a zinc shade`)
  return [zinc(name, `${file} ${anchor}`), found[2] === undefined ? 1 : Number(found[2]) / 100]
}

/** A layer this pass did not touch, kept here so the stacks below are the real ones. */
function fixed(color: keyof typeof ZINC, alpha: number): Layer {
  return [ZINC[color], alpha]
}

function over(source: Rgb, alpha: number, backdrop: Rgb): Rgb {
  return [source[0] * alpha + backdrop[0] * (1 - alpha), source[1] * alpha + backdrop[1] * (1 - alpha), source[2] * alpha + backdrop[2] * (1 - alpha)]
}

function luminance(color: Rgb): number {
  const channel = (value: number): number => {
    const v = value / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2])
}

function contrast(text: Rgb, backdrop: Rgb): number {
  const a = luminance(text)
  const b = luminance(backdrop)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * The ratio a reader gets on the worse of the two extreme backgrounds, with the foreground
 * composited over the same stack it sits on. A translucent foreground barely separates from its
 * own backdrop, which is what this catches.
 */
function worstCase([text, alpha]: Layer, stack: readonly Layer[]): number {
  const under = (base: Rgb): number => {
    const backdrop = stack.reduce<Rgb>((below, [color, a]) => over(color, a, below), base)
    return contrast(over(text, alpha, backdrop), backdrop)
  }
  return Math.min(under(WHITE), under(BLACK))
}

function assertReadable(label: string, text: Layer, stack: readonly Layer[], floor: number): void {
  const ratio = worstCase(text, stack)
  assert.ok(ratio >= floor, `${label} reads ${ratio.toFixed(2)}:1 on the worse extreme, below ${floor}:1`)
}

// Every scrim this pass moved, read where it ships.
const shell = scrim("App.tsx", /w-full h-full flex bg-zinc-950\/(\d+)/)
const loader = scrim("App.tsx", /justify-center bg-zinc-950\/(\d+) backdrop-blur-xs/)
const menu = scrim("components/layout/MainMenu.tsx", /p-2 bg-zinc-950\/(\d+)/)
const section = scrim("components/ui/DropdownSection.tsx", /before:backdrop-blur-sm before:bg-zinc-950\/(\d+)/)
const listPanel = scrim("components/ui/List.tsx", /before:backdrop-blur-sm before:bg-zinc-950\/(\d+)/)
const gridPanel = scrim("components/ui/Grid.tsx", /before:backdrop-blur-sm before:bg-zinc-950\/(\d+)/)
const popupShell = scrim("components/ui/PopupDialogPanel.tsx", /before:backdrop-blur-\[2px\] before:bg-zinc-950\/(\d+)/)
const popupPanel = scrim("components/ui/PopupDialogPanel.tsx", /before:backdrop-blur-sm before:bg-zinc-950\/(\d+)/)

// Layers this pass left alone, but which sit between the scrims above and the text below.
const inputFill = fixed("zinc-950", 0.5) // FormInputs INPUT_BASE_STYLES
const stickyMenu = fixed("zinc-950", 0.15) // StickyMenu before it is scrolled
const filterControl = fixed("zinc-950", 0.5) // the ListboxButton and Combobox shell of each filter
const tableFill = fixed("zinc-950", 0.5) // Table TableWrapper
const rowTint = fixed("zinc-800", 0.3) // the lighter of the two striped rows, so the worse one
const dropdownFill = fixed("zinc-950", 0.5) // the icon picker's floating option list

// The stacks text actually lands on, in paint order.
const PAGE = [shell] as const
const LOADER = [loader] as const
const FORM_SECTION = [shell, section] as const
const MAIN_MENU = [shell, menu] as const
const POPUP = [popupShell, popupPanel] as const
const FORM_INPUT = [shell, section, inputFill] as const
const MOD_FILTER = [shell, stickyMenu, filterControl] as const
const POPUP_TABLE_ROW = [popupShell, popupPanel, tableFill, rowTint] as const
/** The thinnest stack any of the actionable icons sits on, so the worst of the five. */
const ICON = [shell, section, dropdownFill, rowTint] as const

describe("text over the player's background image", () => {
  it("keeps page text readable where the shell scrim is all there is", () => {
    // The home page title and blurb sit straight on the shell, with no panel under them.
    assertReadable("page text on the shell", [ZINC["zinc-200"], 1], PAGE, TEXT_FLOOR)
  })

  it("keeps the startup loader readable", () => {
    // The loader repaints the background image, so it carries its own shell scrim.
    assertReadable("loader text", [ZINC["zinc-200"], 1], LOADER, TEXT_FLOOR)
  })

  it("keeps form field descriptions readable on a section panel", () => {
    // The reported case: the beta updates hint on the settings page.
    const description = foreground("components/ui/FormComponents/FormLayout.tsx", /text-xs text-(zinc-\d+)(?:\/(\d+))? pl-1/)
    assertReadable("form field descriptions", description, FORM_SECTION, TEXT_FLOOR)
  })

  it("keeps the main menu link descriptions readable", () => {
    assertReadable("main menu descriptions", [ZINC["zinc-400"], 1], MAIN_MENU, TEXT_FLOOR)
  })

  it("keeps popup body text readable", () => {
    // Popups repaint the background image themselves, so they carry their own shell scrim.
    assertReadable("popup body text", [ZINC["zinc-400"], 1], POPUP, TEXT_FLOOR)
  })

  it("gives lists and grids a panel readable text can sit on", () => {
    // These two wrap most of what the launcher shows, and text lands directly on both.
    assertReadable("list row text", [ZINC["zinc-400"], 1], [shell, listPanel], TEXT_FLOOR)
    assertReadable("grid card text", [ZINC["zinc-400"], 1], [shell, gridPanel], TEXT_FLOOR)
    assert.equal(listPanel[1], section[1], "the list panel and the form section should carry the same scrim")
    assert.equal(gridPanel[1], section[1], "the grid panel and the form section should carry the same scrim")
  })
})

describe("prompts the player is meant to read and act on", () => {
  it("keeps the shared input placeholders readable while the field is waiting", () => {
    // The add installation name, the add version fields and the custom icon name all land here.
    const placeholder = foreground("components/ui/FormComponents/FormInputs.tsx", /placeholder:text-(zinc-\d+)(?:\/(\d+))?/)
    assertReadable("form input placeholders", placeholder, FORM_INPUT, TEXT_FLOOR)
  })

  it("keeps the mod filter prompts readable", () => {
    const prompts: ReadonlyArray<readonly [string, Layer]> = [
      ["author filter placeholder", foreground("features/mods/components/AuthorFilter.tsx", /placeholder:text-(zinc-\d+)(?:\/(\d+))?/)],
      ["tag filter prompt", foreground("features/mods/components/TagsFilter.tsx", /tagsFilter\.length < 1 && "text-(zinc-\d+)(?:\/(\d+))?"/)],
      ["version filter prompt", foreground("features/mods/components/VersionsFilter.tsx", /versionsFilter\.length < 1 && "text-(zinc-\d+)(?:\/(\d+))?"/)]
    ]
    for (const [label, prompt] of prompts) assertReadable(label, prompt, MOD_FILTER, TEXT_FLOOR)
  })

  it("keeps the modpack import and change summary rows readable", () => {
    const pending = foreground("features/mods/components/ImportModpackPopup.tsx", /case "pending":\s*\n\s*return "text-(zinc-\d+)(?:\/(\d+))?"/)
    const alreadyPresent = foreground("features/mods/components/ModChangeSummaryPopup.tsx", /gap-1 text-sm text-(zinc-\d+)(?:\/(\d+))?"/)
    const arrow = foreground("features/mods/components/ModChangeSummaryPopup.tsx", /PiArrowRightDuotone className="text-(zinc-\d+)(?:\/(\d+))?/)

    assertReadable("pending import rows", pending, POPUP_TABLE_ROW, TEXT_FLOOR)
    assertReadable("already present summary rows", alreadyPresent, POPUP_TABLE_ROW, TEXT_FLOOR)
    // The arrow reads as part of the sentence it sits in, so it follows that row rather than the
    // weaker non-text bar. Pinning it to the row colour keeps the two from drifting apart.
    assert.deepEqual(arrow, alreadyPresent, "the summary arrow should carry the same grey as the row it sits in")
  })

  it("keeps the icons that stand in for a control above the non-text bar", () => {
    // Each of these is the whole visible content of a button or a menu entry. Several have no
    // label beside them, so the icon is the affordance and the 3:1 rule applies.
    const icons: ReadonlyArray<readonly [string, Layer]> = [
      ["install a new version", foreground("features/versions/pages/ListVersions.tsx", /PiPlusCircleDuotone className="text-xl text-(zinc-\d+)(?:\/(\d+))?/)],
      ["look for a version", foreground("features/versions/pages/ListVersions.tsx", /PiMagnifyingGlassDuotone className="text-xl text-(zinc-\d+)(?:\/(\d+))?/)],
      ["add an installation", foreground("features/installations/pages/ListInstallations.tsx", /PiPlusCircleDuotone className="text-3xl text-(zinc-\d+)(?:\/(\d+))?/)],
      ["add an icon from the picker", foreground("features/installations/components/NameAndIconPicker.tsx", /PiPlusCircleDuotone className="text-3xl text-(zinc-\d+)(?:\/(\d+))?/)],
      ["choose a custom icon file", foreground("components/ui/AddCustomIconPupup.tsx", /PiPlusCircleDuotone className="text-3xl text-(zinc-\d+)(?:\/(\d+))?/)]
    ]
    for (const [label, icon] of icons) assertReadable(label, icon, ICON, NON_TEXT_FLOOR)
  })
})
