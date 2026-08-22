import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Routes, Route } from "react-router-dom"

import AddInstallation from "@renderer/features/installations/pages/AddInstallation"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Pins issue #23: AddInstallation used to call ensurePathExists(path)
 * fire-and-forget, so a failed folder creation (permissions, bad path)
 * still added the Installation to the list. It is now awaited and checked:
 * a `false` result blocks the add and notifies instead.
 */

/** AddInstallation navigates to /installations on success; a stub route stands in for the real list page. */
function renderAddInstallation(): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/installations/add" element={<AddInstallation />} />
        <Route path="/installations" element={<p>installations-list</p>} />
      </Routes>
      <NotificationsOverlay />
    </>,
    { route: "/installations/add" }
  )
}

describe("AddInstallation, folder creation failure", () => {
  it("notifies the folder creation failure and does not add the Installation when ensurePathExists resolves false", async () => {
    const user = userEvent.setup()
    const ensurePathExists = vi.fn(async () => false)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ defaultInstallationsFolder: "/installations", gameVersions: [{ version: "1.20.0", path: "/versions/1.20.0" }] })) },
      pathsManager: { ensurePathExists }
    })

    renderAddInstallation()

    // The data folder auto-fills off the default name once gameVersions/config are loaded.
    await waitFor(() => expect((screen.getByPlaceholderText("Installation folder") as HTMLInputElement).value).not.toBe(""))
    await user.click(await screen.findByText("1.20.0"))

    await user.click(screen.getByTitle("Add"))

    await waitFor(() => expect(ensurePathExists).toHaveBeenCalledTimes(1))

    await screen.findByText("Couldn't create the folder for this Installation! Check that RiftLauncher can write to that location, then try again.")

    // Neither the success path nor the navigation away from the form happened.
    expect(screen.queryByText("Installation added successfully!")).toBeNull()
    expect(screen.queryByText("installations-list")).toBeNull()
  })
})
