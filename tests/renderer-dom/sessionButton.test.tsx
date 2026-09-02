import { describe, expect, it, vi } from "vitest"
import { screen, within } from "@testing-library/react"
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
    expect(email.getAttribute("placeholder")).toBeNull()
    expect(password.getAttribute("placeholder")).toBeNull()
    expect(email.className).toContain("user-invalid:border")
    expect(email.classList.contains("invalid:border")).toBe(false)
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "Log in" }).getAttribute("type")).toBe("submit")
    expect(within(dialog).getByText(/RiftLauncher sends your email/i)).toBeTruthy()

    await user.click(within(dialog).getByRole("button", { name: "Read the Privacy Policy" }))
    expect(api.utils.openOnBrowser).toHaveBeenCalledWith("https://github.com/StratumServer/RiftLauncher/blob/main/PRIVACY.md")
  })

  it("supports password visibility and clears password material when cancelled", async () => {
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

    expect(await screen.findByText(/This account requires a 2FA code/i)).toBeTruthy()
    expect(screen.queryByText(/That 2FA code is incorrect/i)).toBeNull()
  })
})
