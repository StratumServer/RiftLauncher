import { describe, expect, it, vi } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import SessionButton from "@renderer/components/ui/SessionButton"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

async function submitLogin(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole("button", { name: "Log in" }))
  await user.type(screen.getByLabelText("Email"), "player@example.test")
  await user.type(screen.getByLabelText("Password"), "correct-horse-battery-staple")
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Log in" }))
}

/**
 * A request failure the main process can classify used to always throw, which the renderer's
 * catch folded into one generic "check your connection or firewall" toast no matter the actual
 * cause (issue #481, reported on Discord after a refusal the log named plainly still showed that
 * sentence). LOGIN now resolves one of four statuses instead when `loginFailureFamily` can place
 * the cause, and each has to land its own sentence here, distinct from the other three and from
 * the generic one the true catch-all keeps.
 */
describe("SessionButton names the family a login request failure belongs to", () => {
  for (const [status, expectedText, unexpectedText] of [
    ["account-restricted", /account service refused this login/i, /couldn't reach/i],
    ["service-error", /answered with an error on its side/i, /couldn't reach/i],
    ["certificate-error", /secure connection couldn't be verified/i, /couldn't reach/i],
    ["network-unreachable", /couldn't reach the login service/i, /secure connection/i]
  ] as const) {
    it(`shows the ${status} sentence, not the generic one`, async () => {
      const login = vi.fn(async () => ({ status }) as AccountLoginResult)
      installMockWindowApi({ accountManager: { login } })

      renderWithProviders(
        <>
          <SessionButton />
          <NotificationsOverlay />
        </>
      )

      await submitLogin()

      expect(await screen.findByText(expectedText)).toBeTruthy()
      expect(screen.queryByText(unexpectedText)).toBeNull()
      expect(screen.queryByText(/invalid email or password/i)).toBeNull()
    })
  }

  /**
   * The proxy half of #481: a login that failed because of a proxy the main process has no
   * client for (an authenticated proxy answering 407, or a SOCKS answer) is classified as
   * `proxy-auth-required`/`proxy-unsupported` in the main process, which join the
   * `network-unreachable` family the renderer already had a sentence for (issue #482).
   * Both reason tokens collapse into the same wire status before they ever cross the IPC
   * boundary, so what a renderer test can prove is this: the sentence the family already
   * shows names a proxy, not just a connection or a firewall. en-US and fr-FR both carry the
   * wording already, so no new string was needed for either.
   */
  it("mentions a proxy in the network-unreachable sentence, the family a proxy failure joins", async () => {
    const login = vi.fn(async () => ({ status: "network-unreachable" }) as AccountLoginResult)
    installMockWindowApi({ accountManager: { login } })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await submitLogin()

    expect(await screen.findByText(/proxy/i)).toBeTruthy()
  })

  it("still shows the generic message for a request failure loginFailureFamily could not place", async () => {
    const login = vi.fn(async () => {
      throw new Error("Login failed")
    })
    installMockWindowApi({ accountManager: { login } })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await submitLogin()

    expect(await screen.findByText(/couldn't reach the login service/i)).toBeTruthy()
    expect(screen.queryByText(/account service refused/i)).toBeNull()
    expect(screen.queryByText(/answered with an error/i)).toBeNull()
    expect(screen.queryByText(/secure connection/i)).toBeNull()
  })
})

/**
 * #481's other half: a wrong password and a wrong email were already told apart from a network
 * failure, but the sentence itself did not say which field to fix, and the most common way to
 * get this refusal is typing the player name where the account's email goes.
 */
describe("SessionButton's wrong-password sentence", () => {
  it("tells the player to use the account email, not the player name", async () => {
    const login = vi.fn(async () => ({ status: "invalid-credentials" }) as AccountLoginResult)
    installMockWindowApi({ accountManager: { login } })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await submitLogin()

    expect(await screen.findByText(/not the player name/i)).toBeTruthy()
  })
})
