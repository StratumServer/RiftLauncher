import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import AddInstallation from "@renderer/features/installations/pages/AddInstallation"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("AddInstallation", () => {
  it("fills the data folder field with the folder picked from the dialog", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/picked/folder"]) },
      pathsManager: { checkPathEmpty: vi.fn(async () => true) }
    })

    renderWithProviders(<AddInstallation />, { route: "/installations/add" })

    const pathInput = (await screen.findByPlaceholderText("Installation folder")) as HTMLInputElement

    await user.click(screen.getByTitle("Browse"))

    await waitFor(() => expect(pathInput.value).toBe("/picked/folder"))
  })

  it("warns without blocking the pick when the chosen folder isn't empty", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/picked/not-empty"]) },
      pathsManager: { checkPathEmpty: vi.fn(async () => false) }
    })

    renderWithProviders(<AddInstallation />, { route: "/installations/add" })

    const pathInput = (await screen.findByPlaceholderText("Installation folder")) as HTMLInputElement

    await user.click(screen.getByTitle("Browse"))

    // The warning does not stop the field from taking the picked path.
    await waitFor(() => expect(pathInput.value).toBe("/picked/not-empty"))
  })

  it("cancelling the dialog leaves the field untouched", async () => {
    const user = userEvent.setup()
    installMockWindowApi({ utils: { selectFolderDialog: vi.fn(async () => []) } })

    renderWithProviders(<AddInstallation />, { route: "/installations/add" })

    const pathInput = (await screen.findByPlaceholderText("Installation folder")) as HTMLInputElement
    const pathBeforePick = pathInput.value

    await user.click(screen.getByTitle("Browse"))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pathInput.value).toBe(pathBeforePick)
  })
})
