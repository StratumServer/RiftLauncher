import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import SessionButton from "@renderer/components/ui/SessionButton"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("SessionButton", () => {
  it("renders the logged-out state once the config has loaded", async () => {
    installMockWindowApi()

    renderWithProviders(<SessionButton />)

    const button = await screen.findByRole("button", { name: "Log in" })
    expect(button).toBeTruthy()
  })

  it("explains the credential boundary and exposes labeled login actions", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi()

    renderWithProviders(<SessionButton />)

    await user.click(await screen.findByRole("button", { name: "Log in" }))

    const dialog = await screen.findByRole("dialog", { name: "Log in to Vintage Story" })
    const email = within(dialog).getByLabelText("Email")
    const password = within(dialog).getByLabelText("Password")
    expect(email.getAttribute("autocomplete")).toBe("username")
    expect(password.getAttribute("autocomplete")).toBe("current-password")
    expect(within(dialog).getByLabelText("2FA Code").getAttribute("autocomplete")).toBe("one-time-code")
    // A placeholder here is a format example, never a second copy of the visible
    // label: the label has to survive the field being filled in, the placeholder does not.
    expect(email.getAttribute("placeholder")).toBe("name@example.com")
    expect(email.getAttribute("placeholder")).not.toBe("Email")
    expect(password.getAttribute("placeholder")).toBe("••••••••")
    expect(password.getAttribute("placeholder")).not.toBe("Password")
    expect(email.className).toContain("user-invalid:border")
    expect(email.classList.contains("invalid:border")).toBe(false)
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "Log in" }).getAttribute("type")).toBe("submit")
    expect(within(dialog).getByText(/RiftLauncher sends your email/i)).toBeTruthy()

    await user.click(within(dialog).getByRole("button", { name: "Read the Privacy Policy" }))
    expect(api.utils.openOnBrowser).toHaveBeenCalledWith("https://github.com/StratumServer/RiftLauncher/blob/main/PRIVACY.md")
  })

  it("does not submit the form when the reveal toggle is clicked", async () => {
    const user = userEvent.setup()
    // An explicit mock, not the helper's default rejection: a stray submit has to be countable
    // here, not a thrown "was called without a mock override" from somewhere else in the tree.
    const login = vi.fn(async () => ({ status: "invalid-credentials" }) as AccountLoginResult)
    installMockWindowApi({ accountManager: { login } })

    renderWithProviders(<SessionButton />)

    await user.click(await screen.findByRole("button", { name: "Log in" }))
    const dialog = await screen.findByRole("dialog", { name: "Log in to Vintage Story" })

    await user.type(within(dialog).getByLabelText("Email"), "player@example.test")
    await user.type(within(dialog).getByLabelText("Password"), "hunter2")

    // The toggle sits inside the login form. A button inside a form submits it unless it says
    // otherwise, so without its type the eye posts the credentials the player is still typing.
    await user.click(within(dialog).getByRole("button", { name: "Show password" }))

    expect(login).toHaveBeenCalledTimes(0)
    // Asserted together so the test cannot pass by the toggle having disappeared.
    expect(within(dialog).getByLabelText("Password").getAttribute("type")).toBe("text")
    expect(within(dialog).getByRole("button", { name: "Hide password" })).toBeTruthy()
  })

  it("clears the password out of the open dialog when a login is refused", async () => {
    const user = userEvent.setup()
    const login = vi.fn(async () => ({ status: "invalid-credentials" }) as AccountLoginResult)
    installMockWindowApi({ accountManager: { login } })

    renderWithProviders(<SessionButton />)

    await user.click(await screen.findByRole("button", { name: "Log in" }))
    const dialog = await screen.findByRole("dialog", { name: "Log in to Vintage Story" })
    await user.type(within(dialog).getByLabelText("Email"), "player@example.test")
    await user.type(within(dialog).getByLabelText("Password"), "correct-horse-battery-staple")
    await user.type(within(dialog).getByLabelText("2FA Code"), "123456")

    await user.click(within(dialog).getByRole("button", { name: "Log in" }))
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1))

    // A refusal leaves the dialog open, which is the only moment the clear is observable: the
    // reopen path clears on the way in, so asserting on a reopened dialog proves nothing about
    // what handleLogin did with the credentials it just sent.
    await waitFor(() => {
      const stillOpen = screen.getByRole("dialog", { name: "Log in to Vintage Story" })
      expect((within(stillOpen).getByLabelText("Password") as HTMLInputElement).value).toBe("")
      expect((within(stillOpen).getByLabelText("2FA Code") as HTMLInputElement).value).toBe("")
    })
    // The email survives on purpose: the player retypes the secret, not the whole form.
    expect((within(dialog).getByLabelText("Email") as HTMLInputElement).value).toBe("player@example.test")
  })

  it("supports password visibility and opens a fresh dialog with no password material", async () => {
    const user = userEvent.setup()
    installMockWindowApi()

    renderWithProviders(<SessionButton />)

    await user.click(await screen.findByRole("button", { name: "Log in" }))
    const dialog = await screen.findByRole("dialog")
    const password = within(dialog).getByLabelText("Password")
    const twoFactor = within(dialog).getByLabelText("2FA Code")

    await user.type(password, "correct-horse-battery-staple")
    await user.type(twoFactor, "12a345678")
    expect((twoFactor as HTMLInputElement).value).toBe("123456")
    const showPassword = within(dialog).getByRole("button", { name: "Show password" })
    expect(showPassword.getAttribute("aria-pressed")).toBe("false")
    await user.click(showPassword)
    expect(password.getAttribute("type")).toBe("text")
    expect(within(dialog).getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true")

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await user.click(await screen.findByRole("button", { name: "Log in" }))
    const reopenedDialog = await screen.findByRole("dialog")
    // This pins the clear-on-open, not the clear-on-cancel: openLogin clears before it opens, so a
    // reopened dialog is empty either way. The refused-login test above is what pins the clear that
    // runs after credentials have actually been sent.
    expect((within(reopenedDialog).getByLabelText("Password") as HTMLInputElement).value).toBe("")
    expect((within(reopenedDialog).getByLabelText("2FA Code") as HTMLInputElement).value).toBe("")
  })

  it("distinguishes a required 2FA code from an incorrect code", async () => {
    const user = userEvent.setup()
    const login = vi.fn(async () => ({ status: "requires-two-factor" }) as AccountLoginResult)
    installMockWindowApi({ accountManager: { login } })

    renderWithProviders(
      <>
        <SessionButton />
        <NotificationsOverlay />
      </>
    )

    await user.click(await screen.findByRole("button", { name: "Log in" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Email"), "player@example.test")
    await user.type(within(dialog).getByLabelText("Password"), "correct-horse-battery-staple")
    await user.click(within(dialog).getByRole("button", { name: "Log in" }))

    // The "Logging in!" info toast holds the single visible toast slot; the
    // 2FA error sits behind it in the queue until the info toast is dismissed.
    await user.click(await screen.findByRole("button", { name: "Discard notification" }))

    expect(await screen.findByText(/This account requires a 2FA code/i)).toBeTruthy()
    expect(screen.queryByText(/That 2FA code is incorrect/i)).toBeNull()
  })
})
