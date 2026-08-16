import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import HomePage from "@renderer/features/home/pages/HomePage"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("HomePage", () => {
  it("opens the trailer on the system browser through the link hook", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi()

    renderWithProviders(<HomePage />, { route: "/" })

    await user.click(screen.getByTitle("Watch the latest trailer on YouTube"))

    expect(api.utils.openOnBrowser).toHaveBeenCalledWith("https://www.youtube.com/watch?v=mgvzBB_--xM")
  })
})
