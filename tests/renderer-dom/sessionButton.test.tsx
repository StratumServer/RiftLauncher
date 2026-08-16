import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"

import SessionButton from "@renderer/components/ui/SessionButton"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("SessionButton", () => {
  it("renders the logged-out state once the config has loaded", async () => {
    installMockWindowApi()

    renderWithProviders(<SessionButton />)

    const button = await screen.findByRole("button", { name: "Log in" })
    expect(button).toBeTruthy()
  })
})
