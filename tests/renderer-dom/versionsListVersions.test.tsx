import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListVersions from "@renderer/features/versions/pages/ListVersions"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("ListVersions", () => {
  it("deletes a version once the uninstall confirmation is accepted", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ version: "1.20.4", path: "/versions/1.20.4" }] })) },
      pathsManager: { deletePath: vi.fn(async () => true) }
    })

    renderWithProviders(<ListVersions />, { route: "/versions" })

    await screen.findByText("1.20.4")

    await user.click(screen.getByTitle("Delete Version"))
    await screen.findByText("Are you sure you want to uninstall this VS Version?")

    await user.click(screen.getByTitle("Uninstall"))

    await waitFor(() => expect(screen.queryByText("1.20.4")).toBeNull())
    expect(api.pathsManager.deletePath).toHaveBeenCalledWith("/versions/1.20.4")
  })
})
