import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import SessionButton from "@renderer/components/ui/SessionButton"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const ACCOUNT_A: AccountPublicType = { email: "a@example.com", playerName: "Alice", playerUid: "uid-a", playerEntitlements: null, hostGameServer: false }
const ACCOUNT_B: AccountPublicType = { email: "b@example.com", playerName: "Bob", playerUid: "uid-b", playerEntitlements: null, hostGameServer: false }

describe("SessionButton with more than one saved account", () => {
  it("shows the active account and lists every saved account once opened", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: { getConfig: async () => createMockConfig({ accounts: [ACCOUNT_A, ACCOUNT_B], activeAccountId: ACCOUNT_A.playerUid }) }
    })

    renderWithProviders(<SessionButton />)

    const trigger = await screen.findByRole("button", { name: "Alice" })
    await user.click(trigger)

    expect(await screen.findByRole("option", { name: /Bob/ })).toBeTruthy()
    expect(screen.getByRole("option", { name: /Add another account/ })).toBeTruthy()
    expect(screen.getByRole("option", { name: "Remove Alice" })).toBeTruthy()
  })

  it("switching to another account persists it as the new active one", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn<(config: ConfigType) => Promise<SaveConfigResult>>(async () => ({ ok: true }))
    installMockWindowApi({
      configManager: { getConfig: async () => createMockConfig({ accounts: [ACCOUNT_A, ACCOUNT_B], activeAccountId: ACCOUNT_A.playerUid }), saveConfig }
    })

    renderWithProviders(<SessionButton />)

    await user.click(await screen.findByRole("button", { name: "Alice" }))
    await user.click(await screen.findByRole("option", { name: /Bob/ }))

    await screen.findByRole("button", { name: "Bob" })
    const lastSaved = saveConfig.mock.calls.at(-1)?.[0]
    expect(lastSaved?.activeAccountId).toBe("uid-b")
  })

  it("opens the login form from the switcher's add option", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: { getConfig: async () => createMockConfig({ accounts: [ACCOUNT_A], activeAccountId: ACCOUNT_A.playerUid }) }
    })

    renderWithProviders(<SessionButton />)

    await user.click(await screen.findByRole("button", { name: "Alice" }))
    await user.click(await screen.findByRole("option", { name: /Add another account/ }))

    expect(await screen.findByPlaceholderText("Email")).toBeTruthy()
  })

  it("removes the active account on confirm", async () => {
    const user = userEvent.setup()
    const removeAccount = vi.fn(async () => true)
    installMockWindowApi({
      configManager: { getConfig: async () => createMockConfig({ accounts: [ACCOUNT_A, ACCOUNT_B], activeAccountId: ACCOUNT_A.playerUid }) },
      accountManager: { removeAccount }
    })

    renderWithProviders(<SessionButton />)

    await user.click(await screen.findByRole("button", { name: "Alice" }))
    await user.click(await screen.findByRole("option", { name: "Remove Alice" }))
    await user.click(await screen.findByRole("button", { name: "Remove Alice" }))

    expect(removeAccount).toHaveBeenCalledWith("uid-a")
    // Alice is gone, Bob is promoted and shown on the trigger.
    expect(await screen.findByRole("button", { name: "Bob" })).toBeTruthy()
  })

  it("leaves the account in the list and shows an error when removal fails", async () => {
    const user = userEvent.setup()
    const removeAccount = vi.fn(async () => false)
    installMockWindowApi({
      configManager: { getConfig: async () => createMockConfig({ accounts: [ACCOUNT_A], activeAccountId: ACCOUNT_A.playerUid }) },
      accountManager: { removeAccount }
    })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await user.click(await screen.findByRole("button", { name: "Alice" }))
    await user.click(await screen.findByRole("option", { name: "Remove Alice" }))
    await user.click(await screen.findByRole("button", { name: "Remove Alice" }))

    expect(removeAccount).toHaveBeenCalledWith("uid-a")
    expect(await screen.findByText("Couldn't remove that account. Try again.")).toBeTruthy()
    // Still there: the trigger keeps showing Alice, not falling back to "Log in".
    expect(screen.getByRole("button", { name: "Alice" })).toBeTruthy()
  })
})
