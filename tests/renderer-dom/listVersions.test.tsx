import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"

import ListVersions from "@renderer/features/versions/pages/ListVersions"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("ListVersions", () => {
  it("renders the empty state -- no game versions, just the two entry points", async () => {
    installMockWindowApi()

    renderWithProviders(<ListVersions />, { route: "/versions" })

    const installLink = await screen.findByTitle("Install a new VS Version")
    expect(installLink).toBeTruthy()
    expect(screen.getByTitle("Add an already installed VS Version")).toBeTruthy()

    // No gv.version rows: the empty state has nothing with a version-shaped
    // list item beyond the two entry points above.
    expect(screen.queryByTitle(/Open folder on the file explorer/)).toBeNull()
  })
})
