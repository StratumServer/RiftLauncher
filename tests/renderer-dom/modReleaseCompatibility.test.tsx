import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"

import InstallModPopup from "@renderer/features/mods/components/InstallModPopup"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The release table a player picks an install from, in both of the flows that render it: the browse
 * page and the update popup inside an installation. #366 shipped two faults here in beta.7.
 *
 * The compatibility hue was handed to the download FormButton through `className`, next to the
 * ghost variant's own `text-zinc-200`. Same element, same specificity, so the winner was whichever
 * rule Tailwind emitted last, which is zinc-200: every icon painted grey and the verdict reached
 * nobody but a mouse hovering for the tooltip. And the supported game versions were rendered in a
 * read-only `<input>` that clipped a long list mid-item with no way to read the rest.
 *
 * A palette utility a component sets, e.g. `text-lime-600` or `text-zinc-200`. Sizes (`text-lg`)
 * and alignment (`text-center`) do not match, which is the point: two of these on one element is
 * the bug, whatever their order in the class list.
 */
const PALETTE_UTILITY = /^text-[a-z]+-\d+$/

const VERDICTS = [
  { tags: ["1.20.0"], modversion: "3.0.0", label: "Tagged", sentence: "Author tagged it as compatible with your selected Vintage Story Version!" },
  {
    tags: ["1.20.4"],
    modversion: "2.0.0",
    label: "Likely",
    sentence: "Author didn't tag it as compatible but there is a 95% chance that it will work on the selected Vintage Story Version!"
  },
  {
    tags: ["1.19.8"],
    modversion: "1.0.0",
    label: "Untagged",
    sentence: "Author didn't tag it as compatible and there is a 90% chance that it will not work on the selected Vintage Story Version!"
  }
] as const

/** The reported case: BetterRuins tags eight game versions on one release. */
const EIGHT_VERSIONS = ["1.22.0", "1.22.1", "1.22.2", "1.22.3", "1.22.4", "1.22.5", "1.22.6", "1.22.7"]

function anInstallation(): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.20.0",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    _modsCount: 0
  }
}

function aRelease(index: number, modversion: string, tags: readonly string[]): unknown {
  return {
    releaseid: index,
    mainfile: `https://mods.example/coolmod-${modversion}.zip`,
    filename: `coolmod-${modversion}.zip`,
    fileid: index,
    downloads: 0,
    tags,
    modidstr: "coolmod",
    modversion,
    created: "2026-01-02T00:00:00Z",
    changelog: ""
  }
}

function aModDetail(releases: readonly { modversion: string; tags: readonly string[] }[]): string {
  return JSON.stringify({
    statuscode: "200",
    mod: { modid: 42, assetid: 4242, name: "Cool Mod", releases: releases.map((release, index) => aRelease(index + 1, release.modversion, release.tags)) }
  })
}

async function renderTable(releases: readonly { modversion: string; tags: readonly string[] }[], { withInstallation = true } = {}): Promise<void> {
  installMockWindowApi({ netManager: { queryURL: vi.fn(async () => aModDetail(releases)) } })

  renderWithProviders(
    <TaskProvider>
      <InstallModPopup modToInstall="coolmod" setModToInstall={() => {}} modName="Cool Mod" installation={withInstallation ? { installation: anInstallation() } : undefined} />
    </TaskProvider>
  )

  await screen.findByText(releases[0]?.modversion ?? "")
}

/** Every palette utility one element sets on itself. */
function paletteClasses(element: Element): string[] {
  return [...element.classList].filter((name) => PALETTE_UTILITY.test(name))
}

describe("the release table's compatibility verdict", () => {
  it("paints the verdict on an element that carries no colour of its own", async () => {
    await renderTable(VERDICTS)

    for (const { sentence } of VERDICTS) {
      const button = screen.getByRole("button", { name: sentence })

      // The button itself must stay out of it. It is where the fix went wrong: the ghost variant
      // already colours this element, and a second colour here is decided by stylesheet order.
      expect(paletteClasses(button)).toEqual(["text-zinc-200"])

      // The icon is repainted from inside instead, where nothing competes for the same property.
      const icon = button.querySelector(".rounded-sm")
      expect(icon).not.toBeNull()
      expect(paletteClasses(icon as Element)).toHaveLength(1)
    }
  })

  it("gives each verdict its own hue", async () => {
    await renderTable(VERDICTS)

    const hues = VERDICTS.map(({ sentence }) => paletteClasses(screen.getByRole("button", { name: sentence }).querySelector(".rounded-sm") as Element)[0])

    expect(new Set(hues).size).toBe(VERDICTS.length)
  })

  it("says the verdict in words, so it does not rest on hue alone", async () => {
    await renderTable(VERDICTS)

    for (const { label } of VERDICTS) {
      const word = screen.getByText(label)
      expect(word.textContent).toBe(label)
      // The word carries the hue too, rather than the hue being the icon's private business.
      expect(paletteClasses(word)).toHaveLength(1)
    }
  })

  it("names the verdict in the download button's accessible name", async () => {
    await renderTable(VERDICTS)

    // A screen reader reaches the same judgement the tooltip gives a mouse.
    for (const { sentence } of VERDICTS) expect(screen.getByRole("button", { name: sentence })).toBeTruthy()
  })
})

describe("the release table's game versions", () => {
  it("shows every supported version, not a clipped prefix", async () => {
    await renderTable([{ modversion: "1.0.0", tags: EIGHT_VERSIONS }])

    const cell = screen.getByText(EIGHT_VERSIONS.join(", "))
    expect(cell.textContent).toBe(EIGHT_VERSIONS.join(", "))
    // The list has to be able to wrap: clipping it to one line is what hid half of it.
    expect(cell.className).not.toMatch(/whitespace-nowrap|text-ellipsis/)
  })

  it("renders the versions as text rather than a read-only field", async () => {
    await renderTable([{ modversion: "1.0.0", tags: EIGHT_VERSIONS }])

    // An input here is a focus stop that announces itself as a textbox for text nobody edits.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0)
    expect(document.querySelector("input")).toBeNull()
  })
})

describe("the release table with no installation picked", () => {
  it("lists the releases and says why nothing can be installed", async () => {
    await renderTable(VERDICTS, { withInstallation: false })

    expect(screen.getByText("No Installation selected!")).toBeTruthy()
    for (const { modversion, tags } of VERDICTS) {
      expect(screen.getByText(modversion)).toBeTruthy()
      expect(screen.getByText(tags.join(", "))).toBeTruthy()
    }
  })

  it("offers no verdict and no download when there is nothing to judge against", async () => {
    await renderTable(VERDICTS, { withInstallation: false })

    for (const { label, sentence } of VERDICTS) {
      expect(screen.queryByText(label)).toBeNull()
      expect(screen.queryByRole("button", { name: sentence })).toBeNull()
    }
  })

  it("keeps the notice out of the way once an installation is picked", async () => {
    await renderTable(VERDICTS)

    expect(screen.queryByText("No Installation selected!")).toBeNull()
  })
})
