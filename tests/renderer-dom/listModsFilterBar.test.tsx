import { describe, expect, it } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { getModsBrowseState } from "@renderer/features/mods/modsBrowseState"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/** Two `/api/mods` entries with different `side` values, so the Side filter has something to narrow. */
const MOD_RESPONSE = {
  statuscode: "200",
  mods: [
    {
      modid: 123,
      assetid: 123,
      name: "Better Ruins",
      summary: "More interesting ruins.",
      modidstrs: ["betterruins"],
      author: "Someone",
      downloads: 42,
      follows: 7,
      comments: 1,
      side: "both",
      logo: "",
      tags: []
    },
    {
      modid: 456,
      assetid: 456,
      name: "Client Only Tool",
      summary: "A client-side helper.",
      modidstrs: ["clientonlytool"],
      author: "Someone Else",
      downloads: 10,
      follows: 2,
      comments: 0,
      side: "client",
      logo: "",
      tags: []
    }
  ]
}

describe("ListMods filter bar", () => {
  it("refilters the visible list when the side filter changes", async () => {
    const user = userEvent.setup()

    installMockWindowApi({
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify(MOD_RESPONSE)
          // authors/gameversions/tags dropdowns query on mount too; an empty named list is enough for them.
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    expect(await screen.findByText("Better Ruins", {}, { timeout: 3000 })).toBeTruthy()
    expect(screen.getByText("Client Only Tool")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Any" }))
    await user.click(await screen.findByText("Client"))

    // The change is debounced (400ms) before it re-queries and re-filters.
    await waitFor(() => expect(screen.queryByText("Better Ruins")).toBeNull(), { timeout: 3000 })
    expect(screen.getByText("Client Only Tool")).toBeTruthy()
  })

  // #414: the favorites-only toggle looked identical on and off. Its one state cue, a
  // "text-yellow-400" on the ghost FormButton's className, lost the cascade to the variant's
  // own "text-zinc-200", so nothing but aria-pressed ever changed. The fix moves the hue onto
  // a solid PiStarFill icon and adds a border-vsl box, both of which win where they sit.
  it("marks the favorites filter as selected once it is on", async () => {
    const user = userEvent.setup()

    installMockWindowApi({
      configManager: { getConfig: async () => createMockConfig({ favMods: [123] }) },
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify(MOD_RESPONSE)
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    expect(await screen.findByText("Better Ruins", {}, { timeout: 3000 })).toBeTruthy()

    const favFilter = screen.getByTitle("Show favorite Mods only")
    const icon = (): SVGElement => {
      const svg = favFilter.querySelector("svg")
      if (!svg) throw new Error("favorites filter icon not found")
      return svg
    }

    expect(favFilter.getAttribute("aria-pressed")).toBe("false")
    expect(favFilter.className).not.toContain("border-vsl")
    expect(icon().getAttribute("class") ?? "").not.toContain("text-yellow-400")
    expect(icon().querySelector('path[opacity="0.2"]')).not.toBeNull()

    await user.click(favFilter)

    expect(favFilter.getAttribute("aria-pressed")).toBe("true")
    // The toggle hands a function to the setter; the browse snapshot must hold the value it gave.
    expect(getModsBrowseState().onlyFav).toBe(true)
    expect(favFilter.className).toContain("border-vsl")
    expect(icon().getAttribute("class")).toContain("text-yellow-400")
    expect(icon().querySelector('path[opacity="0.2"]')).toBeNull()

    // The list narrowing is debounced; the favorited mod stays, the other drops.
    await waitFor(() => expect(screen.queryByText("Client Only Tool")).toBeNull(), { timeout: 3000 })
    expect(screen.getByText("Better Ruins")).toBeTruthy()
  })

  // @headlessui/react's MenuItems defaults to modal=true, which marks the rest of the page
  // inert (aria-hidden + focus-trapped) while it is open. OrderFilter opts out: it is a small
  // sort menu in a filter bar, not a dialog, and the rest of the bar has to stay usable.
  it("keeps the rest of the filter bar reachable while the sort menu is open", async () => {
    const user = userEvent.setup()

    installMockWindowApi({
      netManager: {
        queryURL: async (url: string) => {
          if (url.includes("/api/mods")) return JSON.stringify(MOD_RESPONSE)
          return JSON.stringify({ statuscode: "200", authors: [], gameversions: [], tags: [] })
        }
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    expect(await screen.findByText("Better Ruins", {}, { timeout: 3000 })).toBeTruthy()

    await user.click(screen.getByTitle("Order"))
    await screen.findByText("Trending")

    const searchInput = screen.getByRole("textbox")
    expect(searchInput.closest('[aria-hidden="true"]')).toBeNull()
  })
})
