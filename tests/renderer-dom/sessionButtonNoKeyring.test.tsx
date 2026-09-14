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
