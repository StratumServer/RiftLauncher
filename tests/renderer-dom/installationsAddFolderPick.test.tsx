import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import AddInstallation from "@renderer/features/installations/pages/AddInstallation"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

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

  /**
   * usePickEmptyFolder (#490 item 5) is the survivor of a fold that collapsed three copies of
   * pick-a-folder-and-warn-if-not-empty (config, installations, versions) onto this one hook.
   * Nothing exercised the warning notification itself before this fold, only that the pick was
   * not blocked by it (the test above); this is that missing case, for the hook every caller
   * now shares.
   */
  it("shows the not-empty warning notification, not just an unblocked pick", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/picked/not-empty"]) },
      pathsManager: { checkPathEmpty: vi.fn(async () => false) }
    })

    renderWithProviders(
      <>
        <AddInstallation />
        <NotificationsOverlay />
      </>,
      { route: "/installations/add" }
    )

    await user.click(screen.getByTitle("Browse"))

    expect(await screen.findByText("The folder you've selected is not empty. Make sure there is nothing important in it.")).toBeTruthy()
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
