import { describe, expect, it, onTestFinished, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListVersions from "@renderer/features/versions/pages/ListVersions"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
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

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

    await screen.findByText("1.20.4")
    expect(screen.getByText("Vintage Story 1.21.0")).toBeTruthy()
  })

  it("deletes a version once the uninstall confirmation is accepted", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ version: "1.20.4", path: "/versions/1.20.4" }] })) },
      pathsManager: { deletePath: vi.fn(async () => true) }
    })

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

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

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

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

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

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

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

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

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

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

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

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

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

    await screen.findByText("1.20.4")

    await user.click(screen.getByTitle("Remove from List"))
    await screen.findByText("Are you sure you want to remove VS Version 1.20.4 from the list?")

    await user.click(within(screen.getByRole("dialog")).getByTitle("Remove from List"))

    await waitFor(() => expect(screen.queryByText("1.20.4")).toBeNull())
    expect(api.pathsManager.deletePath).not.toHaveBeenCalled()
  })

  it("renames a version, keeping its number and its folder", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "gv-optimum", label: "1.22.7", version: "1.22.7", path: "/versions/optimum" }] })),
        saveConfig
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

    await screen.findByText("1.22.7")
    await user.click(screen.getByTitle("Rename VS Version"))

    const name = await screen.findByDisplayValue("1.22.7")
    await user.clear(name)
    await user.type(name, "1.22.7 Optimum 0.3.14")
    await user.click(screen.getByTitle("Save"))

    await screen.findByText("1.22.7 Optimum 0.3.14")
    await waitFor(() => expect(saveConfig).toHaveBeenCalled())
    const savedConfig = (saveConfig.mock.calls.at(-1) as unknown as [ConfigType])[0]
    expect(savedConfig.gameVersions[0]).toMatchObject({ id: "gv-optimum", label: "1.22.7 Optimum 0.3.14", version: "1.22.7", path: "/versions/optimum" })
  })

  it("ends the rename on Enter, with the field focused and named", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "gv-a", label: "My build", version: "1.22.7", path: "/versions/a" }] })),
        saveConfig
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

    await screen.findByText("My build")
    await user.click(screen.getByTitle("Rename VS Version"))

    // Named by a label of its own, not by its placeholder, and ready to type in.
    const name = await screen.findByRole("textbox", { name: "Name" })
    await waitFor(() => expect(document.activeElement).toBe(name))

    await user.clear(name)
    await user.type(name, "Renamed by keyboard{Enter}")

    await screen.findByText("Renamed by keyboard")
    await waitFor(() => expect(saveConfig).toHaveBeenCalled())
    const savedConfig = (saveConfig.mock.calls.at(-1) as unknown as [ConfigType])[0]
    expect(savedConfig.gameVersions[0]).toMatchObject({ label: "Renamed by keyboard", version: "1.22.7" })
  })

  it("stops the typed name at the length the config keeps", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "gv-a", label: "My build", version: "1.22.7", path: "/versions/a" }] })),
        saveConfig
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

    await screen.findByText("My build")
    await user.click(screen.getByTitle("Rename VS Version"))

    const name = await screen.findByDisplayValue("My build")
    await user.clear(name)
    await user.type(name, "n".repeat(300))
    await user.click(screen.getByTitle("Save"))

    await waitFor(() => expect(saveConfig).toHaveBeenCalled())
    const savedConfig = (saveConfig.mock.calls.at(-1) as unknown as [ConfigType])[0]
    // normalizeGameVersion drops a longer label for the bare version number, so a
    // name the field let through would be a rename that reports success and is
    // thrown away on the next load.
    expect(savedConfig.gameVersions[0]?.label).toHaveLength(256)
  })

  it("falls back to the version number when the name is cleared", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "gv-a", label: "My build", version: "1.22.7", path: "/versions/a" }] })),
        saveConfig
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

    await screen.findByText("My build")
    await user.click(screen.getByTitle("Rename VS Version"))

    const name = await screen.findByDisplayValue("My build")
    await user.clear(name)
    await user.type(name, "   ")
    await user.click(screen.getByTitle("Save"))

    await screen.findByText("1.22.7")
    await waitFor(() => expect(saveConfig).toHaveBeenCalled())
    const savedConfig = (saveConfig.mock.calls.at(-1) as unknown as [ConfigType])[0]
    expect(savedConfig.gameVersions[0]).toMatchObject({ label: "1.22.7", version: "1.22.7" })
  })

  it("changes nothing when the rename is cancelled", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "gv-a", label: "My build", version: "1.22.7", path: "/versions/a" }] })),
        saveConfig
      }
    })

    renderWithProviders(
      <TaskProvider>
        <ListVersions />
      </TaskProvider>,
      { route: "/versions" }
    )

    await screen.findByText("My build")
    await user.click(screen.getByTitle("Rename VS Version"))

    const name = await screen.findByDisplayValue("My build")
    await user.clear(name)
    await user.type(name, "Something else")
    await user.click(screen.getByTitle("Cancel"))

    await waitFor(() => expect(screen.queryByDisplayValue("Something else")).toBeNull())
    expect(screen.getByText("My build")).toBeTruthy()
    expect(saveConfig).not.toHaveBeenCalled()
  })

  /**
   * The two actions a patched row gains. Both are gated, and the gates are the
   * point: Update only when a newer overlay still covers that build's game
   * version, Remove only when the row is patched at all.
   */
  describe("the Optimum row actions", () => {
    function anOptimumManifest(overrides: Partial<OptimumManifestInfo> = {}): OptimumManifestInfo {
      return {
        optimumVersion: "0.3.14",
        supportedGameVersions: ["1.22.7"],
        downloadUrl: "https://github.com/StratumServer/Optimum/releases/download/v0.3.14/Optimum-v0.3.14-linux-x64-overlay.tar.gz",
        downloadFolder: "/userdata/Cache/Optimum",
        archiveFileName: "Optimum-v0.3.14-linux-x64-overlay.tar.gz",
        ...overrides
      }
    }

    function withRows(gameVersions: (Pick<GameVersionType, "version" | "path"> & Partial<GameVersionType>)[], manifest: OptimumManifestResult): void {
      installMockWindowApi({
        configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions })) },
        optimumManager: { getManifest: vi.fn(async () => manifest) }
      })
    }

    function renderList(): void {
      renderWithProviders(
        <TaskProvider>
          <ListVersions />
        </TaskProvider>,
        { route: "/versions" }
      )
    }

    it("offers Remove on a patched row and on no other", async () => {
      withRows(
        [
          { version: "1.22.7", path: "/versions/optimum", label: "1.22.7 Optimum 0.3.14", variant: { name: "Optimum", version: "0.3.14" } },
          { version: "1.22.7", path: "/versions/plain", label: "1.22.7", id: "gv-plain" }
        ],
        { ok: true, manifest: anOptimumManifest() }
      )

      renderList()
      await screen.findByText("1.22.7 Optimum 0.3.14")

      expect(screen.getAllByTitle("Remove Optimum").length).toBe(1)
    })

    it("offers Update once a newer overlay still covers that build", async () => {
      withRows([{ version: "1.22.7", path: "/versions/optimum", label: "1.22.7 Optimum 0.3.13", variant: { name: "Optimum", version: "0.3.13" } }], {
        ok: true,
        manifest: anOptimumManifest()
      })

      renderList()

      expect(await screen.findByTitle("Update Optimum to 0.3.14")).toBeTruthy()
    })

    it("offers no Update when the row already runs the published overlay", async () => {
      withRows([{ version: "1.22.7", path: "/versions/optimum", label: "1.22.7 Optimum 0.3.14", variant: { name: "Optimum", version: "0.3.14" } }], {
        ok: true,
        manifest: anOptimumManifest()
      })

      renderList()
      await screen.findByText("1.22.7 Optimum 0.3.14")

      expect(screen.queryByTitle("Update Optimum to 0.3.14")).toBeNull()
      expect(screen.getByTitle("Remove Optimum")).toBeTruthy()
    })

    it("offers no Update when the newer overlay dropped that game version", async () => {
      withRows([{ version: "1.22.7", path: "/versions/optimum", label: "1.22.7 Optimum 0.3.13", variant: { name: "Optimum", version: "0.3.13" } }], {
        ok: true,
        manifest: anOptimumManifest({ optimumVersion: "0.4.0", supportedGameVersions: ["1.23.0"] })
      })

      renderList()
      await screen.findByText("1.22.7 Optimum 0.3.13")

      expect(screen.queryByTitle("Update Optimum to 0.4.0")).toBeNull()
    })

    it("offers no Update at all when no manifest was read this session", async () => {
      withRows([{ version: "1.22.7", path: "/versions/optimum", label: "1.22.7 Optimum 0.3.13", variant: { name: "Optimum", version: "0.3.13" } }], {
        ok: false,
        reason: "unreachable"
      })

      renderList()
      await screen.findByText("1.22.7 Optimum 0.3.13")

      expect(screen.queryByTitle("Update Optimum to 0.3.14")).toBeNull()
      expect(screen.getByTitle("Remove Optimum")).toBeTruthy()
    })

    it("says plainly what removing Optimum does, and does nothing until it is confirmed", async () => {
      const user = userEvent.setup()
      const restoreVanilla = vi.fn(async () => ({ ok: true }) as OptimumPatchResult)
      withRows([{ version: "1.22.7", path: "/versions/optimum", label: "1.22.7 Optimum 0.3.14", variant: { name: "Optimum", version: "0.3.14" } }], {
        ok: true,
        manifest: anOptimumManifest()
      })
      installMockWindowApi({
        configManager: {
          getConfig: vi.fn(async () =>
            createMockConfig({ gameVersions: [{ version: "1.22.7", path: "/versions/optimum", label: "1.22.7 Optimum 0.3.14", variant: { name: "Optimum", version: "0.3.14" } }] })
          )
        },
        optimumManager: { getManifest: vi.fn(async () => ({ ok: true as const, manifest: anOptimumManifest() })), restoreVanilla }
      })

      renderList()
      await user.click(await screen.findByTitle("Remove Optimum"))

      expect(screen.getByText("Are you sure you want to remove Optimum from 1.22.7 Optimum 0.3.14?")).toBeTruthy()
      expect(
        screen.getByText(
          "The four game files Optimum replaced are put back, and the row reads as the plain version again. Optimum's shaders and its added language lines stay until you install this VS Version again."
        )
      ).toBeTruthy()

      await user.click(screen.getByText("Cancel"))
      expect(restoreVanilla).not.toHaveBeenCalled()
    })

    it("puts the row back to the plain version once the removal is confirmed", async () => {
      const user = userEvent.setup()
      const restoreVanilla = vi.fn(async () => ({ ok: true }) as OptimumPatchResult)
      installMockWindowApi({
        configManager: {
          getConfig: vi.fn(async () =>
            createMockConfig({ gameVersions: [{ version: "1.22.7", path: "/versions/optimum", label: "1.22.7 Optimum 0.3.14", variant: { name: "Optimum", version: "0.3.14" } }] })
          )
        },
        optimumManager: { getManifest: vi.fn(async () => ({ ok: true as const, manifest: anOptimumManifest() })), restoreVanilla }
      })

      renderList()
      await user.click(await screen.findByTitle("Remove Optimum"))
      await user.click(screen.getAllByText("Remove Optimum").at(-1) as HTMLElement)

      await waitFor(() => expect(restoreVanilla).toHaveBeenCalledWith(expect.any(String), "/versions/optimum"))
      await waitFor(() => expect(screen.getByText("1.22.7")).toBeTruthy())
      // The dialog's own confirm button carries the same label, so this waits for
      // it to leave too: what has to be gone is the action on the row.
      await waitFor(() => expect(screen.queryByTitle("Remove Optimum")).toBeNull())
    })
  })
})
