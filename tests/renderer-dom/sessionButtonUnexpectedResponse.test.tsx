import { describe, expect, it, vi } from "vitest"
import { fireEvent, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import SessionButton from "@renderer/components/ui/SessionButton"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Guards the live-failure fix directly at the surface the player sees: a
 * login attempt whose response the launcher could not read must never show
 * the same toast as a wrong password. Previously, `unreadable-response`
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

    await user.type(screen.getByLabelText("Email"), "player@example.test")
    await user.type(screen.getByLabelText("Password"), "correct-horse-battery-staple")
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Log in" }))
    fireEvent.click(await screen.findByTitle("Discard notification"))

    expect(await screen.findByText(/couldn't read/i)).toBeTruthy()
    expect(screen.queryByText(/invalid email or password/i)).toBeNull()
  })
})
