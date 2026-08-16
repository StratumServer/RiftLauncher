import { describe, expect, it } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListMods from "@renderer/features/mods/pages/ListMods"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { installMockWindowApi } from "./helpers/windowApi"
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
})
