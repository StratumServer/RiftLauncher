import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"

import InstallMod from "@renderer/features/mods/pages/InstallMod"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Picking a release used to happen in a dialog that covered the window, menus included, so the only
 * way out was dismissing it. It is a page now: it keeps the launcher's navigation reachable and is
 * left the same way every other page is. These hold the two halves a player depends on — the way
 * back, and a heading that names the mod straight away rather than echoing its numeric id.
 */
function aModDetail(): string {
  return JSON.stringify({
    statuscode: "200",
    mod: {
      modid: 42,
      assetid: 4242,
      name: "Cool Mod",
      releases: [
        {
          releaseid: 1,
          mainfile: "https://mods.example/coolmod-1.2.0.zip",
          filename: "coolmod-1.2.0.zip",
          fileid: 1,
          downloads: 0,
          tags: ["1.20.0"],
          modidstr: "coolmod",
          modversion: "1.2.0",
          created: "2026-01-02T00:00:00Z",
          changelog: ""
        }
      ]
    }
  })
}

function renderPage(queryURL: () => Promise<string>): void {
  installMockWindowApi({ netManager: { queryURL: vi.fn(queryURL) } })

  renderWithProviders(
    <TaskProvider>
      <Routes>
        <Route path="/mods/install/:modid" element={<InstallMod />} />
      </Routes>
    </TaskProvider>,
    { route: "/mods/install/42" }
  )
}

describe("the install-mod page", () => {
  it("offers a way back to the mod list", async () => {
    renderPage(async () => aModDetail())

    const back = await screen.findByRole("link", { name: "Go back" })
    expect(back.getAttribute("href")).toBe("/mods")

    // The breadcrumb is the second route out, and it names where the player came from.
    const crumb = await screen.findByRole("link", { name: "Mods" })
    expect(crumb.getAttribute("href")).toBe("/mods")
  })

  it("names the mod from the route it was opened with, before the ModDB answers", async () => {
    // A request that never settles: whatever the heading shows here it did not learn from ModDB.
    renderPage(() => new Promise<string>(() => {}))

    expect(await screen.findByText(/List of versions of the 42 Mod/i)).toBeTruthy()
  })

  it("replaces that with the real name once the catalog lands", async () => {
    renderPage(async () => aModDetail())

    await waitFor(() => expect(screen.getByText(/List of versions of the Cool Mod Mod/i)).toBeTruthy())
    expect(screen.getByText("1.2.0")).toBeTruthy()
  })
})
