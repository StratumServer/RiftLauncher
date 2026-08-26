import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import SessionButton from "@renderer/components/ui/SessionButton"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const ACCOUNT: AccountPublicType = { email: "steve@example.com", playerName: "Steve", playerUid: "steve-uid", playerEntitlements: null, hostGameServer: false }

describe("SessionButton", () => {
  it("opens the account switcher and calls the account hook's remove on confirm", async () => {
    const user = userEvent.setup()
    const removeAccount = vi.fn(async () => true)

    installMockWindowApi({
      configManager: { getConfig: async () => createMockConfig({ accounts: [ACCOUNT], activeAccountId: ACCOUNT.playerUid }) },
      accountManager: { removeAccount }
    })

    renderWithProviders(<SessionButton />)

    const button = await screen.findByRole("button", { name: "Steve" })
    await user.click(button)

    const removeOption = await screen.findByRole("option", { name: "Remove Steve" })
    await user.click(removeOption)

    const removeConfirm = await screen.findByRole("button", { name: "Remove Steve" })
    await user.click(removeConfirm)

    expect(removeAccount).toHaveBeenCalledWith("steve-uid")
  })

  it("reports the service as unreachable when the login call throws, not bad credentials", async () => {
    const user = userEvent.setup()
    // A rejected invoke is what a network failure or a firewall block looks like
    // from the renderer: no verdict was ever produced, so the credentials toast
    // would be a lie (a real firewall produced exactly that lie in the field).
    const login = vi.fn(async () => {
      throw new Error("Login failed")
    })

    installMockWindowApi({
      accountManager: { login }
    })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await user.click(await screen.findByRole("button", { name: "Log in" }))
    await user.type(screen.getByPlaceholderText("Email"), "steve@example.com")
    await user.type(screen.getByPlaceholderText("Password"), "hunter2")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByText("Couldn't reach the login service. Check your connection or firewall and try again.")).toBeTruthy()
    expect(screen.queryByText("Invalid email or password!")).toBeNull()
  })

  it("renders the logged-out state once the config has loaded", async () => {
    installMockWindowApi()

    renderWithProviders(<SessionButton />)

    const button = await screen.findByRole("button", { name: "Log in" })
    expect(button).toBeTruthy()
  })
})
