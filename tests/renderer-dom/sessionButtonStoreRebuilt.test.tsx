import { describe, expect, it, vi } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import SessionButton from "@renderer/components/ui/SessionButton"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const ACCOUNT = { email: "player@example.test", playerName: "Player", playerUid: "uid-a", playerEntitlements: null, hostGameServer: false }

async function login(email: string, password: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole("button", { name: "Log in" }))
  await user.type(screen.getByLabelText("Email"), email)
  await user.type(screen.getByLabelText("Password"), password)
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Log in" }))
  await user.click(await screen.findByRole("button", { name: "Discard notification" }))
}

/**
 * #259: a login whose credentials the service accepted, but whose secrets
 * `saveAccountSecrets` could only save by rebuilding an unreadable store, or
 * could not save at all. Neither is an ordinary success and neither is
 * "invalid email or password": the player is told exactly what happened.
 */
describe("SessionButton on an account-store rebuild", () => {
  it("logs the player in and warns that other saved accounts must log in again", async () => {
    const loginFn = vi.fn(async () => ({ status: "success", account: ACCOUNT, storeRebuilt: true }) as AccountLoginResult)
    installMockWindowApi({ accountManager: { login: loginFn } })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await login("player@example.test", "correct-horse-battery-staple")

    expect(await screen.findByText(/couldn't be read/i)).toBeTruthy()
    await userEvent.setup().click(await screen.findByRole("button", { name: "Discard notification" }))
    expect(await screen.findByText(/logged in as player/i)).toBeTruthy()
  })

  it("does not warn about a rebuild on an ordinary success", async () => {
    const loginFn = vi.fn(async () => ({ status: "success", account: ACCOUNT }) as AccountLoginResult)
    installMockWindowApi({ accountManager: { login: loginFn } })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await login("player@example.test", "correct-horse-battery-staple")

    expect(await screen.findByText(/logged in as player/i)).toBeTruthy()
    expect(screen.queryByText(/couldn't be read/i)).toBeNull()
  })

  it("tells the player their login worked but nothing could be saved, when the store could not even be backed up", async () => {
    const loginFn = vi.fn(async () => ({ status: "session-store-unreadable" }) as AccountLoginResult)
    installMockWindowApi({ accountManager: { login: loginFn } })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await login("player@example.test", "correct-horse-battery-staple")

    expect(await screen.findByText(/your login worked/i)).toBeTruthy()
    expect(screen.queryByText(/invalid email or password/i)).toBeNull()
    expect(screen.queryByText(/logged in as/i)).toBeNull()
  })
})
