import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import SessionButton from "@renderer/components/ui/SessionButton"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Guards the live-failure fix directly at the surface the player sees: a
 * login attempt whose response the launcher could not read must never show
 * the same toast as a wrong password. Before this stage, `unreadable-response`
 * had no wire status of its own and fell into the generic catch in
 * SessionButton, which always reported "Invalid email or password!" even
 * though the service never actually refused the credentials.
 */
describe("SessionButton on an unreadable success payload", () => {
  it("tells the player the response could not be read, not that their credentials were wrong", async () => {
    const user = userEvent.setup()
    const login = vi.fn(async () => ({ status: "unexpected-response" }) as AccountLoginResult)

    installMockWindowApi({ accountManager: { login } })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await user.click(await screen.findByRole("button", { name: "Log in" }))

    await user.type(screen.getByPlaceholderText("Email"), "player@example.test")
    await user.type(screen.getByPlaceholderText("Password"), "correct-horse-battery-staple")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByText(/couldn't read/i)).toBeTruthy()
    expect(screen.queryByText(/invalid email or password/i)).toBeNull()
  })
})
