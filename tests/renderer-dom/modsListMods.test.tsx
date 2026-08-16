import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/** One `/api/mods` entry, just enough of the shape parseModListResponse and ListMods both read. */
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
    }
  ]
}

describe("ListMods", () => {
  it("renders results from the mocked ModDB query", async () => {
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

    const modCard = await screen.findByText("Better Ruins", {}, { timeout: 3000 })
    expect(modCard).toBeTruthy()
    expect(screen.getByText("Someone")).toBeTruthy()
  })

  it("shows the no-matching-filters state when the ModDB query comes back empty", async () => {
    installMockWindowApi({
      netManager: {
        queryURL: async () => JSON.stringify({ statuscode: "200", mods: [], authors: [], gameversions: [], tags: [] })
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListMods />
      </TaskProvider>,
      { route: "/mods" }
    )

    expect(await screen.findByText("There are no Mods that match your filters!", {}, { timeout: 3000 })).toBeTruthy()
  })
})
