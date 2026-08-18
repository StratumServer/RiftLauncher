import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListVersions from "@renderer/features/versions/pages/ListVersions"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.20.4",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    ...overrides
  }
}

describe("ListVersions", () => {
  it("renders without crashing when a version string is not valid semver", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            gameVersions: [
              { version: "1.20.4", path: "/versions/1.20.4" },
              { version: "Vintage Story 1.21.0", path: "/versions/custom" }
            ]
          })
        )
      }
    })

    renderWithProviders(<ListVersions />, { route: "/versions" })

    await screen.findByText("1.20.4")
    expect(screen.getByText("Vintage Story 1.21.0")).toBeTruthy()
  })

  it("deletes a version once the uninstall confirmation is accepted", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ version: "1.20.4", path: "/versions/1.20.4" }] })) },
      pathsManager: { deletePath: vi.fn(async () => true) }
    })

    renderWithProviders(<ListVersions />, { route: "/versions" })

    await screen.findByText("1.20.4")

    await user.click(screen.getByTitle("Delete Version"))
    await screen.findByText("Are you sure you want to uninstall this VS Version?")

    await user.click(screen.getByTitle("Uninstall"))

    await waitFor(() => expect(screen.queryByText("1.20.4")).toBeNull())
    expect(api.pathsManager.deletePath).toHaveBeenCalledWith("/versions/1.20.4")
  })

  it("warns naming every installation still on that version, and cancelling deletes nothing", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            gameVersions: [{ version: "1.20.4", path: "/versions/1.20.4" }],
            installations: [anInstallation({ id: "install-a", name: "Survival World" }), anInstallation({ id: "install-b", name: "Creative Sandbox" })]
          })
        )
      },
      pathsManager: { deletePath: vi.fn(async () => true) }
    })

    renderWithProviders(<ListVersions />, { route: "/versions" })

    await screen.findByText("1.20.4")

    await user.click(screen.getByTitle("Delete Version"))
    await screen.findByText("Are you sure you want to uninstall this VS Version?")
    await user.click(screen.getByTitle("Uninstall"))

    await screen.findByText("Survival World, Creative Sandbox still use this VS Version. Deleting it now means they won't launch until you point them at another one.")
    // The first confirm dialog's exit animation can still be mid-flight (and its own
    // "Cancel" button with it) right after the second one mounts; wait it out so only
    // one "Cancel" button is on the page before clicking it.
    await waitFor(() => expect(screen.queryByText("Are you sure you want to uninstall this VS Version?")).toBeNull())
    expect(api.pathsManager.deletePath).not.toHaveBeenCalled()

    await user.click(screen.getByTitle("Cancel"))

    await waitFor(() => expect(screen.queryByText("VS Version in use")).toBeNull())
    expect(screen.getByText("1.20.4")).toBeTruthy()
    expect(api.pathsManager.deletePath).not.toHaveBeenCalled()
  })

  it("deletes the version anyway once the in-use warning is confirmed", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            gameVersions: [{ version: "1.20.4", path: "/versions/1.20.4" }],
            installations: [anInstallation({ id: "install-a", name: "Survival World" }), anInstallation({ id: "install-b", name: "Creative Sandbox" })]
          })
        )
      },
      pathsManager: { deletePath: vi.fn(async () => true) }
    })

    renderWithProviders(<ListVersions />, { route: "/versions" })

    await screen.findByText("1.20.4")

    await user.click(screen.getByTitle("Delete Version"))
    await screen.findByText("Are you sure you want to uninstall this VS Version?")
    await user.click(screen.getByTitle("Uninstall"))

    await screen.findByText("Survival World, Creative Sandbox still use this VS Version. Deleting it now means they won't launch until you point them at another one.")

    await user.click(screen.getByTitle("Delete anyway"))

    await waitFor(() => expect(screen.queryByText("1.20.4")).toBeNull())
    expect(api.pathsManager.deletePath).toHaveBeenCalledWith("/versions/1.20.4")
  })
})
