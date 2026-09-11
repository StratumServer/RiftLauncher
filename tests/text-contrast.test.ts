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
 *
 * A ratio against the backdrop is necessary but not sufficient for a link: #248's fix lightened
 * --color-vsl enough to clear the backdrop, but that same lightening brought it within 1.02:1 of
 * the zinc-400 prose six of the eight links sit inside, so colour alone stopped marking them as
 * links (WCAG 1.4.1). The shared link variant carries `underline` for that reason; this file only
 * checks the backdrop ratio, not the separation from surrounding text, since the underline is what
 * carries that job now.
 */

const RENDERER = resolve(__dirname, "..", "src", "renderer", "src")

/** Tailwind's own palette. `bg-red-700` has no hex anywhere in this repo to read it from. */
const TAILWIND_THEME = resolve(__dirname, "..", "node_modules", "tailwindcss", "theme.css")

const TEXT_FLOOR = 4.5
const NON_TEXT_FLOOR = 3

type Rgb = readonly [number, number, number]
/** A painted layer: its colour and the alpha it is painted at. */
type Layer = readonly [Rgb, number]

/** Tailwind's zinc ramp in sRGB. The scrims and every piece of low-emphasis text come from here. */
const ZINC = {
  "zinc-100": [244, 244, 245],
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

/** One `--color-*` token from the `@theme` block, read as the hex that actually ships. */
function themeColor(name: string): Rgb {
  const found = match("styles.css", new RegExp(`--color-${name}:\\s*#([0-9a-fA-F]{6})`))
  const hex = found[1] as string
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

type ButtonVariant = "primary" | "destructive"
type ButtonState = "default" | "hover" | "active"

function buttonVariantStyle(variant: ButtonVariant): string {
  const found = match("components/ui/buttonStyles.ts", new RegExp(`${variant}: "([^"]+)"`))
  return found[1] as string
}

/** Reads one background utility from the shared variant, including its state prefix and alpha. */
function buttonFill(variant: ButtonVariant, state: ButtonState, token: string, color: Rgb): Layer {
  const utility = state === "default" ? `bg-${token}` : `${state}:bg-${token}`
  const escapedUtility = utility.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const found = new RegExp(`(?:^| )${escapedUtility}(?:/(\\d+))?(?: |$)`).exec(buttonVariantStyle(variant))
  assert.ok(found, `${variant} ${state} no longer uses ${utility}`)
  return [color, found[1] === undefined ? 1 : Number(found[1]) / 100]
}

/**
 * Tailwind v4 publishes its palette in OKLCH, so a fill like `bg-red-700` carries no hex to read:
 * the ratio below needs the sRGB a screen actually shows. This is Ottosson's OKLab basis and matrix
 * into linear-light sRGB, then the sRGB transfer function.
 *
 * Out-of-gamut channels are clamped rather than gamut-mapped. red-700 is the one that needs it, its
 * green converts to -17, and clamping lands on 193,0,7, the value Tailwind publishes for that token.
 * The assertion below checks this against a shade the table above already carries, so a mistyped
 * coefficient cannot pass unnoticed.
 */
function oklchToSrgb(lightness: number, chroma: number, hueDegrees: number): Rgb {
  const hue = (hueDegrees * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const short = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const encode = (linear: number): number => {
    const gamma = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
    return Math.min(255, Math.max(0, Math.round(gamma * 255)))
  }
  return [
    encode(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    encode(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    encode(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short)
  ]
}

/** One `--color-*` from Tailwind's theme, read as the OKLCH it ships and converted to sRGB. */
function tailwindColor(name: string): Rgb {
  const theme = readFileSync(TAILWIND_THEME, "utf8")
  const found = new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(theme)
  assert.ok(found, `no --color-${name} in tailwindcss/theme.css, the palette this test reads has moved`)
  return oklchToSrgb(Number(found[1] as string) / 100, Number(found[2] as string), Number(found[3] as string))
}

/** The four `text-*` shades of one status/kind map, keyed by the name the component gives them. */
function colourMap(file: string, anchor: RegExp): Record<string, string> {
  const entries = [...(match(file, anchor)[1] as string).matchAll(/"?([a-z-]+)"?:\s*"text-([a-z]+-\d+|vsl?d?)"/g)]
  assert.ok(entries.length >= 4, `${anchor} in ${file} no longer lists four colours`)
  return Object.fromEntries(entries.map((entry) => [entry[1] as string, entry[2] as string]))
}

function toastTypeColours(file: string): Record<string, string> {
  return colourMap(file, /const FONT_COLOR_TYPES = \{([^}]+)\}/)
}

function taskStatusColours(file: string): Record<string, string> {
  return colourMap(file, /const STATUS_COLORS = \{([^}]+)\}/)
}

/** A `text-*` token from either Tailwind's palette or this repo's own `--color-*` theme block. */
function tailwindOrTheme(token: string): Rgb {
  return /^vs/.test(token) ? themeColor(token) : tailwindColor(token)
}

/** One `text-<token>` foreground outside the zinc ramp, read out of the component that ships it. */
function paletteForeground(file: string, anchor: RegExp): Layer {
  return [tailwindColor(match(file, anchor)[1] as string), 1]
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
/**
 * The bar pinned to the top of Mods, Manage Mods, Installations and VS Versions, in both of its
 * scroll states. #430: past 20px the scrolled one was an opaque bg-zinc-800, so the bar's own
 * backdrop-blur had nothing left to show and the list vanished behind a grey slab. Both states are
 * scrims now, and both are read out of the component rather than written down here.
 */
const stickyMenu = scrim("components/ui/StickyMenu.tsx", /scrTop > 20 \? "bg-zinc-950\/\d+" : "bg-zinc-950\/(\d+)"/)
const stickyMenuScrolled = scrim("components/ui/StickyMenu.tsx", /scrTop > 20 \? "bg-zinc-950\/(\d+)"/)

// Layers this pass left alone, but which sit between the scrims above and the text below.
const inputFill = fixed("zinc-950", 0.5) // FormInputs INPUT_BASE_STYLES
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
const STICKY_BAR = [shell, stickyMenu] as const
const STICKY_BAR_SCROLLED = [shell, stickyMenuScrolled] as const
const MOD_FILTER = [shell, stickyMenu, filterControl] as const
const POPUP_TABLE_ROW = [popupShell, popupPanel, tableFill, rowTint] as const
// The same release table also renders on the browse page, which has no popup panel over the shell,
// so a row there sits on one scrim fewer and is the worse of the two backdrops.
const PAGE_TABLE_ROW = [shell, tableFill, rowTint] as const
/** The thinnest stack any of the actionable icons sits on, so the worst of the five. */
const ICON = [shell, section, dropdownFill, rowTint] as const

// Scrims the vsl accent links and icons sit under, not touched by #236.
const toast = scrim("components/layout/NotificationsOverlay.tsx", /text-center bg-zinc-950\/(\d+) backdrop-blur-sm/)
const tasksPanel = scrim("components/ui/ActivityCenter.tsx", /max-h-\[32rem\] flex flex-col bg-zinc-950\/(\d+) backdrop-blur-md/)
const menuCard = scrim("features/installations/components/InstallationsDropdownMenu.tsx", /backdrop-blur-xs bg-zinc-950\/(\d+) border border-zinc-400\/5 group/)

const LIST_PANEL = [shell, listPanel] as const
const SECTION_TABLE = [shell, section, tableFill] as const
const MENU_CARD = [shell, menu, menuCard] as const
const TOAST = [shell, toast] as const
// ActivityCenter renders inside MainMenu's own header scrim (`<ActivityCenter />` in MainMenu.tsx), so the
// real stack under a task row carries that scrim too, not just the popover panel's own.
const TASKS_ROW = [shell, menu, tasksPanel, rowTint] as const
// The panel's own chrome (headings, summary, empty state) sits on the panel with no row under it.
const TASKS_PANEL = [shell, menu, tasksPanel] as const

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

  /**
   * #430: the sticky bar is the one surface that changes fill as the player scrolls, so both of its
   * states are measured. Its labels come from the ghost button variant and its breadcrumbs set no
   * colour at all, taking the one `body` carries, so both are read where they ship.
   *
   * The two assertions under them are what the reported bug would fail: a fill at full alpha leaves
   * the bar's own backdrop-blur with nothing to show, and a scrolled fill no heavier than the
   * resting one stops separating the bar from the rows sliding under it.
   */
  it("keeps the sticky bar readable and still see-through once the page is scrolled", () => {
    const label = foreground("components/ui/buttonStyles.ts", /ghost: "[^"]*text-(zinc-\d+)(?:\/(\d+))?/)
    // Nothing in the breadcrumbs sets a colour, so what they paint with is the body's own.
    const breadcrumb = foreground("../index.html", /<body class="[^"]*text-(zinc-\d+)(?:\/(\d+))?/)

    assertReadable("sticky bar button label at rest", label, STICKY_BAR, TEXT_FLOOR)
    assertReadable("sticky bar button label when scrolled", label, STICKY_BAR_SCROLLED, TEXT_FLOOR)
    assertReadable("sticky bar breadcrumb at rest", breadcrumb, STICKY_BAR, TEXT_FLOOR)
    assertReadable("sticky bar breadcrumb when scrolled", breadcrumb, STICKY_BAR_SCROLLED, TEXT_FLOOR)

    assert.ok(stickyMenuScrolled[1] < 1, `the scrolled sticky bar paints at ${stickyMenuScrolled[1]}, which leaves its backdrop-blur nothing to show`)
    assert.ok(stickyMenuScrolled[1] > stickyMenu[1], "the scrolled sticky bar should be the heavier of the two fills, so it separates from the rows under it")
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
      ["version filter prompt", foreground("features/mods/components/VersionsFilter.tsx", /versionsFilter\.length < 1 && "text-(zinc-\d+)(?:\/(\d+))?"/)],
      ["installed mods select filter prompt", foreground("features/mods/components/InstalledModsSelectFilter.tsx", /!value && "text-(zinc-\d+)(?:\/(\d+))?"/)],
      ["installed mods tag filter prompt", foreground("features/mods/components/InstalledTagsFilter.tsx", /tagsFilter\.length < 1 && "text-(zinc-\d+)(?:\/(\d+))?"/)]
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

  /**
   * #384: the downgrade/replace and downloading/update hues joined statusColor's switch as part of
   * the readable-table pass, but nothing before this measured them the way #366 measures the
   * release verdicts below, which is exactly how text-red-700 shipped at 2.18:1 unnoticed. Both are
   * outside the zinc ramp, so they read through paletteForeground/tailwindColor like the verdict
   * words rather than through the zinc table at the top of this file.
   */
  it("keeps the modpack import row's downgrade and update hues readable on the popup table", () => {
    const file = "features/mods/components/ImportModpackPopup.tsx"
    const downgradeOrReplace = paletteForeground(file, /case "downgrade":\s*\n\s*case "replace":\s*\n\s*return "text-([a-z]+-\d+)"/)
    const downloadingOrUpdate = paletteForeground(file, /case "downloading":\s*\n\s*case "update":\s*\n\s*return "text-([a-z]+-\d+)"/)

    assertReadable("downgrade/replace row hue", downgradeOrReplace, POPUP_TABLE_ROW, TEXT_FLOOR)
    assertReadable("downloading/update row hue", downloadingOrUpdate, POPUP_TABLE_ROW, TEXT_FLOOR)
  })

  /**
   * #366: the release table's compatibility verdict. The three hues used to be handed to the
   * download FormButton through `className`, where the ghost variant's own `text-zinc-200` won the
   * cascade, so none of them ever painted anything and none of them was ever measured. They paint
   * now (the icon and the word beside it), which puts them in scope here for the first time.
   *
   * That is how `text-red-700` survived: rendered for real it reads 2.18:1 on a table row, below
   * even the non-text floor. The verdict word takes the text floor. The icon takes the non-text
   * floor and gets its own stack, because the row the launcher recommends updating to paints a
   * lime tint behind the icon which lifts the backdrop under it.
   */
  it("keeps the release compatibility verdict readable in both flows", () => {
    const file = "features/mods/components/ModReleaseList.tsx"
    const updatableTint: Layer = [tailwindColor("lime-600"), Number(match(file, /_updatableTo === release\.modversion && "bg-lime-600\/(\d+)"/)[1]) / 100]

    const verdicts: ReadonlyArray<readonly [string, RegExp]> = [
      ["declared", /declared: \{ className: "text-([a-z]+-\d+)"/],
      ["same-minor", /"same-minor": \{ className: "text-([a-z]+-\d+)"/],
      ["undeclared", /undeclared: \{ className: "text-([a-z]+-\d+)"/]
    ]

    for (const [verdict, anchor] of verdicts) {
      const colour = paletteForeground(file, anchor)
      assertReadable(`${verdict} verdict word on the browse page`, colour, PAGE_TABLE_ROW, TEXT_FLOOR)
      assertReadable(`${verdict} verdict word in the update popup`, colour, POPUP_TABLE_ROW, TEXT_FLOOR)
      assertReadable(`${verdict} verdict icon on the recommended row`, colour, [...PAGE_TABLE_ROW, updatableTint], NON_TEXT_FLOOR)
    }
  })

  it("keeps the icons that stand in for a control above the non-text bar", () => {
    // Each of these is the whole visible content of a button: there is no label beside it, so the
    // icon is the affordance and the 3:1 rule applies. Actions that ship a label are covered by
    // the test below instead, because there the icon is no longer what carries the meaning.
    const icons: ReadonlyArray<readonly [string, Layer]> = [
      ["add an icon from the picker", foreground("features/installations/components/NameAndIconPicker.tsx", /PiPlusCircleDuotone className="text-3xl text-(zinc-\d+)(?:\/(\d+))?/)],
      ["choose a custom icon file", foreground("components/ui/AddCustomIconPupup.tsx", /PiPlusCircleDuotone className="text-3xl text-(zinc-\d+)(?:\/(\d+))?/)]
    ]
    for (const [label, icon] of icons) assertReadable(label, icon, ICON, NON_TEXT_FLOOR)
  })

  /**
   * #414: the favorites-only filter toggle and the per-card favorite star. Both handed
   * `text-yellow-400` to a ghost FormButton through `className`, where the variant's own
   * `text-zinc-200` wins the cascade (#366), so the hue never painted and neither was ever
   * measured here. They paint now, on a solid PiStarFill that carries the hue itself, so the
   * non-text bar applies: each star is the whole visible content of a button with no label.
   *
   * The filter star is a ghost button on the sticky menu, so it takes the shell and the
   * StickyMenu scrim but not the `filterControl` fill the dropdown triggers carry. The card
   * star floats on a mod logo the launcher does not control, so a hue alone cannot clear the
   * bar there whatever the hue: it now carries a `bg-zinc-950` pill in both its resting and
   * its hover state, and this pins both, since the hover fill would otherwise replace the pill.
   */
  it("keeps the favorite star readable in the filter bar and on a mod card", () => {
    const filterStar = paletteForeground("features/mods/components/ModsFilterBar.tsx", /<PiStarFill className="text-([a-z]+-\d+)"/)
    assertReadable("favorites filter star", filterStar, STICKY_BAR, NON_TEXT_FLOOR)

    const cardFile = "features/mods/components/ModListCard.tsx"
    const cardStar = paletteForeground(cardFile, /<PiStarFill className="text-([a-z]+-\d+)"/)
    const pill: Layer = [ZINC["zinc-950"], Number(match(cardFile, /text-lg bg-zinc-950\/(\d+)/)[1]) / 100]
    const pillHover: Layer = [ZINC["zinc-950"], Number(match(cardFile, /hover:bg-zinc-950\/(\d+)/)[1]) / 100]
    assertReadable("favorite card star at rest", cardStar, [pill], NON_TEXT_FLOOR)
    assertReadable("favorite card star on hover", cardStar, [pillHover], NON_TEXT_FLOOR)
  })

  /**
   * Everything the notification area puts on screen, pinned in one place.
   *
   * The audit that came with this found two real failures here and a dozen values that happened to
   * pass with nothing holding them there. red-800 on a failed task row read 1.97:1, which made the
   * one line a player has to read the least readable thing in the panel, and the error toast's icon
   * read 2.34:1. Both are read out of the components below rather than written down again, so a
   * shade that moves fails here instead of shipping.
   */
  it("keeps every toast readable on the scrim it ships on", () => {
    const overlay = "components/layout/NotificationsOverlay.tsx"
    const body = foreground(overlay, /text-xs text-(zinc-\d+)(?:\/(\d+))? break-words/)
    const dismiss = foreground(overlay, /p-1 text-(zinc-\d+)(?:\/(\d+))? shrink-0/)

    assertReadable("toast body", body, TOAST, TEXT_FLOOR)
    assertReadable("toast dismiss icon", dismiss, TOAST, NON_TEXT_FLOOR)

    // The type icon is the only thing that says which kind of message this is, so it carries a
    // meaning on its own and the non-text bar applies to all four.
    for (const [kind, token] of Object.entries(toastTypeColours(overlay))) {
      assertReadable(`${kind} toast icon`, [tailwindOrTheme(token), 1], TOAST, NON_TEXT_FLOOR)
    }
  })

  it("keeps every Activity Center task row readable", () => {
    const panel = "components/ui/ActivityCenter.tsx"
    const operation = foreground(panel, /text-xs text-(zinc-\d+)(?:\/(\d+))? break-words/)
    const description = foreground(panel, /text-xs text-(zinc-\d+)(?:\/(\d+))? line-clamp-2/)
    const percentage = foreground(panel, /text-xs text-(zinc-\d+)(?:\/(\d+))? tabular-nums/)
    const failure = paletteForeground(panel, /task.status === "failed" && <p className="text-xs text-([a-z]+-\d+)"/)
    const heading = foreground(panel, /text-xs uppercase tracking-wide text-(zinc-\d+)(?:\/(\d+))?/)
    const summary = foreground(panel, /text-xs text-(zinc-\d+)(?:\/(\d+))? leading-tight/)
    const emptyState = foreground(panel, /p-4 text-center text-sm font-bold text-(zinc-\d+)(?:\/(\d+))?/)

    assertReadable("task operation and status line", operation, TASKS_ROW, TEXT_FLOOR)
    assertReadable("task description", description, TASKS_ROW, TEXT_FLOOR)
    assertReadable("task percentage", percentage, TASKS_ROW, TEXT_FLOOR)
    assertReadable("failed task explanation", failure, TASKS_ROW, TEXT_FLOOR)
    assertReadable("section heading", heading, TASKS_PANEL, TEXT_FLOOR)
    assertReadable("panel summary", summary, TASKS_PANEL, TEXT_FLOOR)
    assertReadable("empty state", emptyState, TASKS_PANEL, TEXT_FLOOR)

    // Each status icon is the row's only colour cue for how that task ended.
    for (const [status, token] of Object.entries(taskStatusColours(panel))) {
      if (token === "vsl") continue // the accent, already covered by the block below
      assertReadable(`${status} task icon`, [tailwindOrTheme(token), 1], TASKS_ROW, NON_TEXT_FLOOR)
    }
  })

  it("keeps the active task badge readable on the accent fill it sits on", () => {
    const badge = match("components/ui/ActivityCenter.tsx", /rounded-full bg-(vs) text-\[10px\] leading-none text-(white)/)
    assert.equal(badge[2], "white", "the active task count no longer paints its own label")
    assertReadable("active task count", [WHITE, 1], [[themeColor(badge[1] as string), 1]], TEXT_FLOOR)
  })

  it("keeps Activity Center history text readable on both row tints", () => {
    const historyBody = foreground("components/ui/ActivityCenter.tsx", /text-xs break-words text-(zinc-\d+)(?:\/(\d+))?/)
    const answered = foreground("components/ui/ActivityCenter.tsx", /mt-1 text-xs text-(zinc-\d+)(?:\/(\d+))?/)

    assertReadable("Activity Center notification body", historyBody, TASKS_ROW, TEXT_FLOOR)
    assertReadable("Activity Center answered marker", answered, TASKS_ROW, TEXT_FLOOR)
  })

  /**
   * An action that ships `icon` renders the icon and its label as one control, and the label's
   * colour comes from the button variant. An icon that sets a `text-zinc-*` of its own there is
   * always the dimmer of the two, which reads as a disabled control sitting next to live text.
   * Nothing stops a call site from adding one back, so this pins the absence.
   */
  it("lets a labelled action's icon take the same colour as its label", () => {
    const labelled = [
      ["install a new version", "features/versions/pages/ListVersions.tsx", "PiPlusCircleDuotone"],
      ["look for a version", "features/versions/pages/ListVersions.tsx", "PiMagnifyingGlassDuotone"],
      ["add an installation", "features/installations/pages/ListInstallations.tsx", "PiPlusCircleDuotone"]
    ] as const

    for (const [label, file, icon] of labelled) {
      const source = read(file)
      const rendered = new RegExp(`icon=\\{<${icon}\\b[^}]*\\}`).exec(source)
      assert.ok(rendered, `${label} no longer renders ${icon} through the shared icon prop`)
      assert.ok(!/text-zinc-/.test(rendered[0]), `${label} dims its icon with ${rendered[0]}, so it no longer matches its own label`)
    }
  })
})

/**
 * #248 follow-up to #236: --color-vsl (the brand accent used as text-vsl for links, plus two
 * status icons) was left out of the original pass and read 3.15:1 on its binding stack. The fix
 * lightens the token rather than darkening it, because every text-vsl call site renders through
 * the same translucent zinc-950 scrim stack over the player's background image that the rest of
 * this file measures, never on a real white surface: the worst case is that stack over a white
 * image, not white itself. --color-vs and --color-vsd are separate tokens that style the active
 * menu marker and the enabled toggle; they carry light text on top rather than being text
 * themselves, so they are untouched here.
 */
describe("the brand accent where it carries text", () => {
  it("keeps every accent link readable on the panel it ships on", () => {
    const accent: Layer = [themeColor("vsl"), 1]
    // The shared variant owns both the accent colour and underline. Each call site must opt into
    // that semantic variant so the visual treatment cannot drift between button implementations.
    match("components/ui/buttonStyles.ts", /link: "[^"]*text-vsl[^"]*underline/)
    const links: ReadonlyArray<readonly [string, RegExp, string, readonly Layer[]]> = [
      ["add installation start-params link", /startParamsLink=\{[\s\S]*?<NormalButton[\s\S]*?variant="link"/, "features/installations/pages/AddInstallation.tsx", FORM_SECTION],
      ["edit installation start-params link", /startParamsLink=\{[\s\S]*?<NormalButton[\s\S]*?variant="link"/, "features/installations/pages/EditInstallation.tsx", FORM_SECTION],
      ["logs folder link", /folderlink:\s*\([\s\S]*?<NormalButton[\s\S]*?variant="link"/, "features/info/pages/InfoAndHelpPage.tsx", FORM_SECTION],
      ["no installed mods link", /link:\s*\([\s\S]*?<LinkButton[\s\S]*?variant="link"/, "features/mods/components/NoInstalledModsNotice.tsx", LIST_PANEL],
      ["mods section issues link", /openExternalLink\(ISSUES_URL\)[\s\S]{0,120}variant="link"/, "features/mods/components/InstalledModsSectionHeader.tsx", LIST_PANEL],
      ["mods section discord link", /openExternalLink\(DISCORD_URL\)[\s\S]{0,120}variant="link"/, "features/mods/components/InstalledModsSectionHeader.tsx", LIST_PANEL],
      ["no game versions link", /link:\s*\([\s\S]*?<LinkButton[\s\S]*?variant="link"/, "features/installations/components/GameVersionPicker.tsx", SECTION_TABLE],
      ["no installations link", /link:\s*\([\s\S]*?<LinkButton[\s\S]*?variant="link"/, "features/installations/components/InstallationsDropdownMenu.tsx", MENU_CARD]
    ]
    for (const [label, anchor, file, stack] of links) {
      match(file, anchor) // fails loudly, naming the file, if the link class or its underline has moved
      assertReadable(label, accent, stack, TEXT_FLOOR)
    }
  })

  it("keeps the accent status icons above the non-text bar", () => {
    const accent: Layer = [themeColor("vsl"), 1]
    match("components/layout/NotificationsOverlay.tsx", /info: "text-vsl"/)
    assertReadable("info toast icon", accent, TOAST, NON_TEXT_FLOOR)
    match("components/ui/ActivityCenter.tsx", /pending: "text-vsl"/)
    assertReadable("pending task icon", accent, TASKS_ROW, NON_TEXT_FLOOR)
  })

  it("keeps the Grid selected-card border above the non-text bar", () => {
    // #258: the border used to sit at partial alpha, which barely separated from the panel behind
    // it (1.53:1 worst case, below the 3:1 floor for a boundary that is the sole selected-state
    // cue: see ModListCard.tsx's `selected={installed}`). It is opaque now, but the backdrop it
    // reads against is still the card's own bg-vsd/NN fill composited over the grid panel, not the
    // panel alone: a border painted at the default border-box clip shows through the fill wherever
    // the fill itself has any transparency, which bg-vsd/NN always does here.
    const fillAlpha = Number(match("components/ui/Grid.tsx", /selected \? "bg-vsd\/(\d+) border-vsl"/)[1]) / 100
    const fill: Layer = [themeColor("vsd"), fillAlpha]
    const border: Layer = [themeColor("vsl"), 1]
    assertReadable("Grid selected-card border", border, [shell, gridPanel, fill], NON_TEXT_FLOOR)
  })

  it("keeps the accent ramp and its selected borders coherent", () => {
    const dark = luminance(themeColor("vsd"))
    const base = luminance(themeColor("vs"))
    const light = luminance(themeColor("vsl"))
    assert.ok(dark < base && base < light, "the vs/vsl/vsd ramp should stay dark-to-light in that order")

    // The ConfigPage tile border has a different backdrop on each of its two edges, so there is no
    // single ratio to assert here. Inside is the player's own thumbnail. Outside is the section panel
    // over the shell, which is FORM_SECTION above, so the accent's ratio on that edge is already
    // pinned by the link assertions against a stricter floor than a border needs. What is left is the
    // width, which is what keeps hue from being the only mark of the selected state, so this checks
    // the border is still 2px and still --color-vsl.
    match("features/config/pages/ConfigPage.tsx", /selected \? "border-2 border-vsl" : "border border-zinc-400\/5"/)
  })
})

/**
 * The two filled variants put their label on a fill of their own, so nothing else in this file
 * measures them: every other stack here ends at the player's background image, and these two never
 * reach it. Each assertion reads the fill and the shade out of the shipped variant string, so
 * changing either one has to come back through here. State fills are included because a hover or
 * active colour that lightens past the text floor is still the same readable control to the player.
 */
describe("button labels on the fill they ship on", () => {
  it("reads Tailwind's OKLCH palette the same way the sRGB table above does", () => {
    // zinc-200 is in both the hand-maintained table at the top of this file and Tailwind's own
    // theme. They have to agree, or the red-700 conversion below is measuring an invented colour.
    assert.deepEqual(tailwindColor("zinc-200"), ZINC["zinc-200"])
  })

  it("keeps the primary action's label readable on the brand fill", () => {
    // The fill is named in the anchor on purpose: moving it off bg-vs fails this loudly instead of
    // silently measuring a colour the button no longer uses.
    const label = foreground("components/ui/buttonStyles.ts", /primary: "[^"]*\bbg-vs\b[^"]*text-(zinc-\d+)(?:\/(\d+))?/)
    const fills: ReadonlyArray<readonly [ButtonState, string, Rgb]> = [
      ["default", "vs", themeColor("vs")],
      ["hover", "vs", themeColor("vs")],
      ["active", "vsd", themeColor("vsd")]
    ]
    for (const [state, token, color] of fills) assertReadable(`primary button label in ${state}`, label, [buttonFill("primary", state, token, color)], TEXT_FLOOR)
  })

  it("keeps the destructive action's label readable on the red fill", () => {
    const label = foreground("components/ui/buttonStyles.ts", /destructive: "[^"]*\bbg-red-700\b[^"]*text-(zinc-\d+)(?:\/(\d+))?/)
    const fills: ReadonlyArray<readonly [ButtonState, string, Rgb]> = [
      ["default", "red-700", tailwindColor("red-700")],
      ["hover", "red-700", tailwindColor("red-700")],
      ["active", "red-800", tailwindColor("red-800")]
    ]
    for (const [state, token, color] of fills) assertReadable(`destructive button label in ${state}`, label, [buttonFill("destructive", state, token, color)], TEXT_FLOOR)
  })
})
