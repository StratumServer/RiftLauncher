import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ConfigPage from "@renderer/features/config/pages/ConfigPage"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("ConfigPage", () => {
  it("updates the installations folder setting after a folder pick", async () => {
    const user = userEvent.setup()
    const PICKED_PATH = "/mock/picked/installations"

    installMockWindowApi({
      utils: { selectFolderDialog: async () => [PICKED_PATH] },
      pathsManager: { checkPathEmpty: async () => true }
    })

    renderWithProviders(<ConfigPage />, { route: "/config" })

    // Installations folder, VS Versions folder, Backups folder, in that DOM order: the first
    // "Browse" button is the installations picker.
    const browseButtons = await screen.findAllByRole("button", { name: "Browse" })
    await user.click(browseButtons[0])

    expect(await screen.findByDisplayValue(PICKED_PATH)).toBeTruthy()
  })
})
