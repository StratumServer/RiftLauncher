import { describe, expect, it, vi } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import SessionButton from "@renderer/components/ui/SessionButton"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

async function submitLogin(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole("button", { name: "Log in" }))
  await user.type(screen.getByLabelText("Email"), "player@example.test")
  await user.type(screen.getByLabelText("Password"), "correct-horse-battery-staple")
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Log in" }))
}

function renderWithLoginResult(result: AccountLoginResult): MockedBridgeAPI {
  const api = installMockWindowApi({ accountManager: { login: vi.fn(async () => result) } })

  renderWithProviders(
    <>
      <SessionButton />
      <NotificationsOverlay />
    </>
  )

  return api
}

/**
 * Regression on #542: the account store held sessions a real system keyring sealed, the player
 * turned the basic-store setting on, and the next login could not read them. This is the
 * renderer's half of the fix: the wire flag it gets is `sessionKeyringSealed`, not the plain
 * `sessionInMemoryOnly` a no-keyring machine sends, because the guidance differs (there is a
 * working keyring here, so pointing at the setup guide would be wrong) and the two must never be
 * shown as the same notification.
 */
describe("SessionButton on a login whose store is sealed by a keyring the basic backend cannot reach", () => {
  const ACCOUNT = { email: "player@example.test", playerName: "Player", playerUid: "uid-a", playerEntitlements: null, hostGameServer: false }

  it("logs the player in and says the session will not be remembered while the setting is on", async () => {
    renderWithLoginResult({ status: "success", account: ACCOUNT, sessionKeyringSealed: true })

    await submitLogin()

    expect(await screen.findByText(/logged in as player/i)).toBeTruthy()
    expect(await screen.findByText(/cannot be read while this setting is on/i)).toBeTruthy()
  }, 15000)

  it("does not offer the no-keyring setup guide: a keyring is already working here", async () => {
    renderWithLoginResult({ status: "success", account: ACCOUNT, sessionKeyringSealed: true })

    await submitLogin()
    await screen.findByText(/logged in as player/i)

    expect(screen.queryByRole("button", { name: "Read the keyring guide" })).toBeNull()
  }, 15000)

  it("marks the stored account as lasting only for this run", async () => {
    const api = renderWithLoginResult({ status: "success", account: ACCOUNT, sessionKeyringSealed: true })

    await submitLogin()
    await screen.findByText(/logged in as player/i)

    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
    expect(saved?.accounts).toEqual([{ ...ACCOUNT, sessionOnly: true }])
  }, 15000)

  it("shows the account as the one in use, the same as a saved login", async () => {
    renderWithLoginResult({ status: "success", account: ACCOUNT, sessionKeyringSealed: true })

    await submitLogin()

    expect(await screen.findByRole("button", { name: /player/i })).toBeTruthy()
  }, 15000)
})
