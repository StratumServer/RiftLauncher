import { describe, expect, it, onTestFinished, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListVersions from "@renderer/features/versions/pages/ListVersions"
import { changeLanguage } from "@renderer/i18n"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.20.4",
    gameVersionId: "gv-1",
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
    await screen.findByText("Are you sure you want to uninstall VS Version 1.20.4?")

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
    await screen.findByText("Are you sure you want to uninstall VS Version 1.20.4?")
    await user.click(screen.getByTitle("Uninstall"))

    await screen.findByText("Survival World, Creative Sandbox still use this VS Version. Deleting it now means they won't launch until you point them at another one.")
    // The first confirm dialog's exit animation can still be mid-flight (and its own
    // "Cancel" button with it) right after the second one mounts; wait it out so only
    // one "Cancel" button is on the page before clicking it.
    await waitFor(() => expect(screen.queryByText("Are you sure you want to uninstall VS Version 1.20.4?")).toBeNull())
    expect(api.pathsManager.deletePath).not.toHaveBeenCalled()

    await user.click(screen.getByTitle("Cancel"))

    await waitFor(() => expect(screen.queryByText("VS Version in use")).toBeNull())
    expect(screen.getByText("1.20.4")).toBeTruthy()
    expect(api.pathsManager.deletePath).not.toHaveBeenCalled()
  })

  it("folds installations past the cap into a translated count instead of a hardcoded 'and N more'", async () => {
    const user = userEvent.setup()
    const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"]
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            gameVersions: [{ version: "1.20.4", path: "/versions/1.20.4" }],
            installations: names.map((name, index) => anInstallation({ id: `install-${index}`, name }))
          })
        )
      }
    })

    renderWithProviders(<ListVersions />, { route: "/versions" })

    await screen.findByText("1.20.4")
    await user.click(screen.getByTitle("Delete Version"))
    await screen.findByText("Are you sure you want to uninstall VS Version 1.20.4?")
    await user.click(screen.getByTitle("Uninstall"))

    // 7 installations, capped at 5 shown: the remaining 2 fold into the translated "and {{count}} more".
    await screen.findByText("Alpha, Beta, Gamma, Delta, Epsilon and 2 more still use this VS Version. Deleting it now means they won't launch until you point them at another one.")
  })

  it("keeps the in-use warning fully French when the UI language is French, including past the installation cap", async () => {
    expect(await changeLanguage("fr-FR")).toBe(true)
    onTestFinished(async () => {
      await changeLanguage("en-US")
    })

    const user = userEvent.setup()
    const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"]
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            gameVersions: [{ version: "1.20.4", path: "/versions/1.20.4" }],
            installations: names.map((name, index) => anInstallation({ id: `install-${index}`, name }))
          })
        )
      }
    })

    renderWithProviders(<ListVersions />, { route: "/versions" })

    await screen.findByText("1.20.4")
    await user.click(screen.getByTitle("Supprimer la version"))
    await screen.findByText("Êtes-vous sûr de vouloir désinstaller la version de VS 1.20.4 ?")
    await user.click(screen.getByTitle("Désinstaller"))

    // Neither "and" nor "more" belongs in this sentence once the UI is French: the count folds
    // through the "et {{count}} autres" key, not the connector that used to be hardcoded in English.
    const warning = await screen.findByText(
      "Alpha, Beta, Gamma, Delta, Epsilon et 2 autres utilisent encore cette version de VS. La supprimer maintenant les empêchera de démarrer tant que vous ne leur en aurez pas indiqué une autre."
    )
    expect(warning.textContent).not.toMatch(/\b(and|more)\b/i)
  })

  it("checks installations against the selected build id when version numbers are shared", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            gameVersions: [
              { id: "gv-vanilla", label: "Vanilla", version: "1.22.7", path: "/versions/vanilla" },
              { id: "gv-optimum", label: "Optimum", version: "1.22.7", path: "/versions/optimum" }
            ],
            installations: [
              anInstallation({ id: "install-vanilla", name: "Vanilla World", gameVersionId: "gv-vanilla" }),
              anInstallation({ id: "install-optimum", name: "Optimum World", gameVersionId: "gv-optimum" })
            ]
          })
        )
      }
    })

    renderWithProviders(<ListVersions />, { route: "/versions" })

    const vanillaRow = (await screen.findByText("Vanilla")).closest("li")
    await user.click(within(vanillaRow as HTMLElement).getByTitle("Delete Version"))
    await screen.findByText("Are you sure you want to uninstall VS Version Vanilla?")
    await user.click(screen.getByTitle("Uninstall"))

    await screen.findByText("Vanilla World still use this VS Version. Deleting it now means they won't launch until you point them at another one.")
    expect(screen.queryByText(/Optimum World still use/)).toBeNull()
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
    await screen.findByText("Are you sure you want to uninstall VS Version 1.20.4?")
    await user.click(screen.getByTitle("Uninstall"))

    await screen.findByText("Survival World, Creative Sandbox still use this VS Version. Deleting it now means they won't launch until you point them at another one.")

    await user.click(screen.getByTitle("Delete anyway"))

    await waitFor(() => expect(screen.queryByText("1.20.4")).toBeNull())
    expect(api.pathsManager.deletePath).toHaveBeenCalledWith("/versions/1.20.4")
  })

  it("unregisters a linked version without deleting its folder", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ version: "1.20.4", path: "/games/vintagestory", linked: true }] })) },
      pathsManager: { deletePath: vi.fn(async () => true) }
    })

    renderWithProviders(<ListVersions />, { route: "/versions" })

    await screen.findByText("1.20.4")

    await user.click(screen.getByTitle("Remove from List"))
    await screen.findByText("Are you sure you want to remove VS Version 1.20.4 from the list?")

    await user.click(within(screen.getByRole("dialog")).getByTitle("Remove from List"))

    await waitFor(() => expect(screen.queryByText("1.20.4")).toBeNull())
    expect(api.pathsManager.deletePath).not.toHaveBeenCalled()
  })
})
