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
 * links (WCAG 1.4.1). The eight text-vsl link call sites also carry `underline` for that reason;
 * this file only checks the backdrop ratio, not the separation from surrounding text, since the
 * underline is what carries that job now.
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

/** One `--color-*` token from the `@theme` block, read as the hex that actually ships. */
function themeColor(name: string): Rgb {
  const found = match("styles.css", new RegExp(`--color-${name}:\\s*#([0-9a-fA-F]{6})`))
  const hex = found[1] as string
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
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

// Scrims the vsl accent links and icons sit under, not touched by #236.
const toast = scrim("components/layout/NotificationsOverlay.tsx", /text-center bg-zinc-950\/(\d+) backdrop-blur-sm/)
const tasksPanel = scrim("components/ui/TasksMenu.tsx", /max-h-60 flex flex-col bg-zinc-950\/(\d+) backdrop-blur-md/)
const menuCard = scrim("features/installations/components/InstallationsDropdownMenu.tsx", /backdrop-blur-xs bg-zinc-950\/(\d+) border border-zinc-400\/5 group/)

const LIST_PANEL = [shell, listPanel] as const
const SECTION_TABLE = [shell, section, tableFill] as const
const MENU_CARD = [shell, menu, menuCard] as const
const TOAST = [shell, toast] as const
// TasksMenu renders inside MainMenu's own header scrim (`<TasksMenu />` in MainMenu.tsx), so the
// real stack under a task row carries that scrim too, not just the popover panel's own.
const TASKS_ROW = [shell, menu, tasksPanel, rowTint] as const

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
    // Every anchor requires "underline" right on the class string, not just "text-vsl": colour
    // alone no longer separates this accent from the zinc-400/zinc-200 prose it sits inside (see
    // the file header), so the underline is the part of each of these that actually marks a link.
    // No anchor bridges more than whitespace between its call site and its class string, so none
    // can slide past a link that lost its underline onto a later one in the same file that kept it.
    const links: ReadonlyArray<readonly [string, RegExp, string, readonly Layer[]]> = [
      ["add installation start-params link", /Client_startup_parameters"\)\}\s+className="text-vsl underline"/, "features/installations/pages/AddInstallation.tsx", FORM_SECTION],
      ["edit installation start-params link", /Client_startup_parameters"\)\} className="text-vsl underline"/, "features/installations/pages/EditInstallation.tsx", FORM_SECTION],
      ["logs folder link", /onClick=\{openLogsFolder\} className="text-vsl underline"/, "features/info/pages/InfoAndHelpPage.tsx", FORM_SECTION],
      ["no installed mods link", /to="\/mods" className="text-vsl underline"/, "features/mods/components/NoInstalledModsNotice.tsx", LIST_PANEL],
      ["mods section issues link", /openExternalLink\(ISSUES_URL\)\s+\}\}\s+className="text-vsl underline"/, "features/mods/components/InstalledModsSectionHeader.tsx", LIST_PANEL],
      ["mods section discord link", /openExternalLink\(DISCORD_URL\)\s+\}\}\s+className="text-vsl underline"/, "features/mods/components/InstalledModsSectionHeader.tsx", LIST_PANEL],
      ["no game versions link", /to="\/versions" className="text-vsl underline"/, "features/installations/components/GameVersionPicker.tsx", SECTION_TABLE],
      ["no installations link", /to="\/installations" className="text-vsl underline"/, "features/installations/components/InstallationsDropdownMenu.tsx", MENU_CARD]
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
    match("components/ui/TasksMenu.tsx", /pending: "text-vsl"/)
    assertReadable("pending task icon", accent, TASKS_ROW, NON_TEXT_FLOOR)
  })

  it("keeps the accent ramp and its selected borders coherent", () => {
    const dark = luminance(themeColor("vsd"))
    const base = luminance(themeColor("vs"))
    const light = luminance(themeColor("vsl"))
    assert.ok(dark < base && base < light, "the vs/vsl/vsd ramp should stay dark-to-light in that order")

    // The Grid border is decorative, not the sole indicator of the selected state (it sits at 25%
    // alpha alongside a bg-vsd/50 fill), so it gets no contrast assertion here, only a pin that it
    // still tracks --color-vsl; its own non-text-contrast gap predates this change and is tracked
    // separately (issue filed alongside this PR).
    match("components/ui/Grid.tsx", /selected \? "bg-vsd\/50 border-vsl\/(\d+)"/)
    // The ConfigPage tile border has a different backdrop on each of its two edges, so there is no
    // single ratio to assert here. Inside is the player's own thumbnail. Outside is the section panel
    // over the shell, which is FORM_SECTION above, so the accent's ratio on that edge is already
    // pinned by the link assertions against a stricter floor than a border needs. What is left is the
    // width, which is what keeps hue from being the only mark of the selected state, so this checks
    // the border is still 2px and still --color-vsl.
    match("features/config/pages/ConfigPage.tsx", /selected \? "border-2 border-vsl" : "border border-zinc-400\/5"/)
  })
})
