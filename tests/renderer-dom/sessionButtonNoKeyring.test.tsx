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
 * A Debian KDE player on 1.7.0-beta.10 was told to check their connection and their firewall while
 * the log said `secure-storage-unavailable`: the machine has no wallet, which no amount of network
 * checking fixes. The keyring sentence has to say what is missing and hand over the page that says
 * how to set one up.
 */
describe("SessionButton on a machine with no keyring", () => {
  it("names the missing keyring instead of blaming the connection", async () => {
    renderWithLoginResult({ status: "no-keyring" })

    await submitLogin()

    expect(await screen.findByText(/no system keyring was found/i)).toBeTruthy()
    expect(screen.queryByText(/check your connection/i)).toBeNull()
    expect(screen.queryByText(/invalid email or password/i)).toBeNull()
  }, 15000)

  it("offers the keyring guide, and opens it in the browser rather than in the launcher", async () => {
    const user = userEvent.setup()
    const api = renderWithLoginResult({ status: "no-keyring" })

    await submitLogin()
    await user.click(await screen.findByRole("button", { name: "Read the keyring guide" }))

    expect(vi.mocked(api.utils.openOnBrowser).mock.calls).toEqual([["https://riftlauncher.stratumvs.dev/docs/get-started/installation/linux#session-storage-and-keyrings"]])
  }, 15000)
})

/**
 * The other half of #481: the credentials were accepted and there is simply nowhere to keep them,
 * so the login stands for this run. The player has to end up logged in, and has to be told that
 * this one does not survive quitting rather than finding out at the next start.
 */
describe("SessionButton on a login whose session is only held in memory", () => {
  const ACCOUNT = { email: "player@example.test", playerName: "Player", playerUid: "uid-a", playerEntitlements: null, hostGameServer: false }

  it("logs the player in and says the session will not be remembered", async () => {
    renderWithLoginResult({ status: "success", account: ACCOUNT, sessionInMemoryOnly: true })

    await submitLogin()

    expect(await screen.findByText(/logged in as player/i)).toBeTruthy()
    expect(await screen.findByText(/only until you close riftlauncher/i)).toBeTruthy()
    expect(await screen.findByRole("button", { name: "Read the keyring guide" })).toBeTruthy()
  }, 15000)

  it("shows the account as the one in use, the same as a saved login", async () => {
    renderWithLoginResult({ status: "success", account: ACCOUNT, sessionInMemoryOnly: true })

    await submitLogin()

    expect(await screen.findByRole("button", { name: /player/i })).toBeTruthy()
  }, 15000)

  /**
   * The account has to reach the config, because that list is what names the account the game
   * launches as. It must not reach it looking like a saved one: the secrets behind it are in
   * this process and nowhere else, so the record says so and the next startup drops it.
   */
  it("marks the stored account as lasting only for this run", async () => {
    const api = renderWithLoginResult({ status: "success", account: ACCOUNT, sessionInMemoryOnly: true })

    await submitLogin()
    await screen.findByText(/logged in as player/i)

    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
    expect(saved?.accounts).toEqual([{ ...ACCOUNT, sessionOnly: true }])
  }, 15000)

  it("leaves the mark off an ordinary saved login", async () => {
    const api = renderWithLoginResult({ status: "success", account: ACCOUNT })

    await submitLogin()
    await screen.findByText(/logged in as player/i)

    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
    expect(saved?.accounts).toEqual([ACCOUNT])
  }, 15000)

  it("says nothing about keyrings on an ordinary saved login", async () => {
    renderWithLoginResult({ status: "success", account: ACCOUNT })

    await submitLogin()

    expect(await screen.findByText(/logged in as player/i)).toBeTruthy()
    expect(screen.queryByText(/no system keyring/i)).toBeNull()
  }, 15000)
})
