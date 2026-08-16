import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import SessionButton from "@renderer/components/ui/SessionButton"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const ACCOUNT: AccountPublicType = { playerName: "Steve" } as AccountPublicType

describe("SessionButton", () => {
  it("opens the logged-in menu and calls the account hook's logout on confirm", async () => {
    const user = userEvent.setup()
    const logout = vi.fn(async () => true)

    installMockWindowApi({
      configManager: { getConfig: async () => createMockConfig({ account: ACCOUNT }) },
      accountManager: { logout }
    })

    renderWithProviders(<SessionButton />)

    const button = await screen.findByRole("button", { name: "Steve" })
    await user.click(button)

    const logoutConfirm = await screen.findByRole("button", { name: "Log out" })
    await user.click(logoutConfirm)

    expect(logout).toHaveBeenCalledTimes(1)
  })

  it("renders the logged-out state once the config has loaded", async () => {
    installMockWindowApi()

    renderWithProviders(<SessionButton />)

    const button = await screen.findByRole("button", { name: "Log in" })
    expect(button).toBeTruthy()
  })
})
