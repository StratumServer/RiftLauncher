import { describe, expect, it, vi } from "vitest"
import { act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CONFIG_ACTIONS, useConfigDispatch, useGameVersions } from "@renderer/features/config/contexts/ConfigContext"
import LookForAVersion from "@renderer/features/versions/pages/LookForAVersion"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("LookForAVersion", () => {
  it("uses the host platform when rejecting a Windows folder already in use", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      utils: {
        getOs: vi.fn(async () => "win32" as NodeJS.Platform),
        selectFolderDialog: vi.fn(async () => ["Games\\VintageStory"])
      },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.22.7" })) },
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ version: "1.22.7", path: "games/vintagestory" }] })),
        saveConfig
      }
    })

    renderWithProviders(
      <>
        <LookForAVersion />
        <NotificationsOverlay />
      </>,
      { route: "/versions/look-for-a-version" }
    )

    await user.click(screen.getByTitle("Browse"))
    await screen.findByDisplayValue("Games\\VintageStory")
    await user.click(screen.getByTitle("Add"))

    await waitFor(() => expect(saveConfig).not.toHaveBeenCalled())
    expect(await screen.findByText("That folder is already in use.")).toBeTruthy()
  })

  it("registers a second build with the same version when its folder is different", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/optimum-1.22.7"]) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.22.7" })) },
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ version: "1.22.7", path: "/games/vanilla-1.22.7" }] })),
        saveConfig
      }
    })

    renderWithProviders(<LookForAVersion />, { route: "/versions/look-for-a-version" })

    await user.click(screen.getByTitle("Browse"))
    await screen.findByDisplayValue("/games/optimum-1.22.7")
    await user.click(screen.getByTitle("Add"))

    await waitFor(() => expect(saveConfig).toHaveBeenCalled())
    const savedConfig = (saveConfig.mock.calls.at(-1) as unknown as [ConfigType])[0]
    expect(savedConfig.gameVersions).toHaveLength(2)
    const addedVersion = savedConfig.gameVersions.find((gameVersion) => gameVersion.path === "/games/optimum-1.22.7") as GameVersionType & { id: string; label: string }
    expect(addedVersion).toMatchObject({ version: "1.22.7", label: "1.22.7", id: expect.any(String) })
  })

  it("registers the build with the edited display label while keeping its version number", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/optimum-1.22.7"]) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.22.7" })) },
      configManager: { saveConfig }
    })

    renderWithProviders(<LookForAVersion />, { route: "/versions/look-for-a-version" })

    await user.click(screen.getByTitle("Browse"))
    await screen.findByDisplayValue("/games/optimum-1.22.7")
    const label = await screen.findByPlaceholderText("Name")
    await user.clear(label)
    await user.type(label, "Optimum 1.22.7")
    await user.click(screen.getByTitle("Add"))

    await waitFor(() => expect(saveConfig).toHaveBeenCalled())
    const savedConfig = (saveConfig.mock.calls.at(-1) as unknown as [ConfigType])[0]
    const addedVersion = savedConfig.gameVersions.find((gameVersion) => gameVersion.path === "/games/optimum-1.22.7")
    expect(addedVersion).toMatchObject({ version: "1.22.7", label: "Optimum 1.22.7" })
  })

  it("prefills the name with the fork the build named itself as, leaving the version number alone", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/optimum-1.22.7"]) },
      gameManager: {
        lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.22.7", variant: { name: "Optimum" as const, version: "0.3.14" } }))
      }
    })

    renderWithProviders(<LookForAVersion />, { route: "/versions/look-for-a-version" })

    await user.click(screen.getByTitle("Browse"))

    expect(await screen.findByDisplayValue("1.22.7 Optimum 0.3.14")).toBeTruthy()
    expect((screen.getByPlaceholderText("VS Version found") as HTMLInputElement).value).toBe("1.22.7")
  })

  it("registers whatever the player types over the prefilled name", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/optimum-1.22.7"]) },
      gameManager: {
        lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.22.7", variant: { name: "Optimum" as const, version: "0.3.14" } }))
      },
      configManager: { saveConfig }
    })

    renderWithProviders(<LookForAVersion />, { route: "/versions/look-for-a-version" })

    await user.click(screen.getByTitle("Browse"))
    const label = await screen.findByDisplayValue("1.22.7 Optimum 0.3.14")
    await user.clear(label)
    await user.type(label, "Fork, for the mod bug")
    await user.click(screen.getByTitle("Add"))

    await waitFor(() => expect(saveConfig).toHaveBeenCalled())
    const savedConfig = (saveConfig.mock.calls.at(-1) as unknown as [ConfigType])[0]
    expect(savedConfig.gameVersions.find((gameVersion) => gameVersion.path === "/games/optimum-1.22.7")).toMatchObject({ version: "1.22.7", label: "Fork, for the mod bug" })
  })

  it("prefills the name with the bare version number when the build names nothing", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/vanilla-1.22.7"]) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.22.7" })) }
    })

    renderWithProviders(<LookForAVersion />, { route: "/versions/look-for-a-version" })

    await user.click(screen.getByTitle("Browse"))
    await screen.findByDisplayValue("/games/vanilla-1.22.7")

    expect((screen.getByPlaceholderText("Name") as HTMLInputElement).value).toBe("1.22.7")
  })

  it("fills the folder and version fields once a version is detected", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/1.20.4"]) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.20.4" })) }
    })

    renderWithProviders(<LookForAVersion />, { route: "/versions/look-for-a-version" })

    await user.click(screen.getByTitle("Browse"))

    expect(await screen.findByDisplayValue("/games/1.20.4")).toBeTruthy()
    expect((screen.getByPlaceholderText("VS Version found") as HTMLInputElement).value).toBe("1.20.4")
  })

  it("notifies and keeps the folder set but the version empty when detection finds nothing", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/empty"]) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: false as const })) }
    })

    renderWithProviders(
      <>
        <LookForAVersion />
        <NotificationsOverlay />
      </>,
      { route: "/versions/look-for-a-version" }
    )

    await user.click(screen.getByTitle("Browse"))

    expect(await screen.findByText("Couldn't detect a VS Version on that folder automatically. If you're sure it has Vintage Story installed, type the version in below.")).toBeTruthy()
    expect((screen.getByPlaceholderText("Folder") as HTMLInputElement).value).toBe("/games/empty")
    expect((screen.getByPlaceholderText("VS Version found") as HTMLInputElement).value).toBe("")
  })

  it("registers a folder with a hand-typed version when detection could not find one", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/unreleased-build"]) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: false as const })) },
      configManager: { saveConfig }
    })

    renderWithProviders(<LookForAVersion />, { route: "/versions/look-for-a-version" })

    await user.click(screen.getByTitle("Browse"))
    await screen.findByDisplayValue("/games/unreleased-build")

    await user.type(screen.getByPlaceholderText("VS Version found"), "1.22.0-pre.1")
    await user.click(screen.getByTitle("Add"))

    expect(saveConfig).toHaveBeenCalled()
    const savedConfig = (saveConfig.mock.calls[0] as unknown as [ConfigType])[0]
    const addedVersion = savedConfig.gameVersions.find((gv) => gv.version === "1.22.0-pre.1")
    expect(addedVersion).toBeTruthy()
    expect(addedVersion!.linked).toBe(true)
    expect(addedVersion!.path).toBe("/games/unreleased-build")
  })

  it("refuses a hand-typed version that is nothing but whitespace", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/unreleased-build"]) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: false as const })) },
      configManager: { saveConfig }
    })

    renderWithProviders(
      <>
        <LookForAVersion />
        <NotificationsOverlay />
      </>,
      { route: "/versions/look-for-a-version" }
    )

    await user.click(screen.getByTitle("Browse"))
    await screen.findByDisplayValue("/games/unreleased-build")
    await screen.findByText("Couldn't detect a VS Version on that folder automatically. If you're sure it has Vintage Story installed, type the version in below.")
    await user.click(screen.getByRole("button", { name: "Discard notification" }))

    await user.type(screen.getByPlaceholderText("VS Version found"), "   ")
    await user.click(screen.getByTitle("Add"))

    expect(await screen.findByText("No folder is selected, or the one you picked has no Vintage Story Version in it.")).toBeTruthy()
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it("dispatches ADD_GAME_VERSION with linked: true when registering", async () => {
    const user = userEvent.setup()
    const saveConfig = vi.fn(async () => ({ ok: true }) as SaveConfigResult)
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/external/1.20.4"]) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.20.4" })) },
      configManager: { saveConfig }
    })

    renderWithProviders(<LookForAVersion />, { route: "/versions/look-for-a-version" })

    await user.click(screen.getByTitle("Browse"))
    await screen.findByDisplayValue("/external/1.20.4")

    await user.click(screen.getByTitle("Add"))

    expect(saveConfig).toHaveBeenCalled()
    const savedConfig = (saveConfig.mock.calls[0] as unknown as [ConfigType])[0]
    const addedVersion = savedConfig.gameVersions.find((gv) => gv.version === "1.20.4")
    expect(addedVersion).toBeTruthy()
    expect(addedVersion!.linked).toBe(true)
    expect(addedVersion!.path).toBe("/external/1.20.4")
  })

  describe("a folder whose approval ran out (#731)", () => {
    const SUCCESS = "That VS Version was successfully added."

    /** A change the player makes after Add, saved with the whole state like every other. */
    function FavouriteAMod(): JSX.Element {
      const configDispatch = useConfigDispatch()
      return <button onClick={() => configDispatch({ type: CONFIG_ACTIONS.ADD_FAV_MOD, payload: { modid: 42 } })}>favourite a mod</button>
    }

    /** Main's answer to a save naming a path nobody trusts any more, with the refused paths in it. */
    function refusing(untrusted: string): (config: ConfigType) => Promise<SaveConfigResult> {
      return async (config) => (config.gameVersions.some((gameVersion) => gameVersion.path === untrusted) ? { ok: false, reason: "unauthorized-path", refusedPaths: [untrusted] } : { ok: true })
    }

    it("asks for the folder to be picked again, and adds nothing, when main no longer trusts the folder at Add", async () => {
      const user = userEvent.setup()
      const saveConfig = vi.fn(async (_config: ConfigType) => ({ ok: true }) as SaveConfigResult)
      // The pick was looked at in time; ten minutes later the same call is refused.
      const lookForAGameVersion = vi
        .fn()
        .mockResolvedValueOnce({ exists: true as const, installedGameVersion: "1.20.4" })
        .mockRejectedValue(new TypeError("Unmanaged game version path"))
      installMockWindowApi({ utils: { selectFolderDialog: vi.fn(async () => ["/external/1.20.4"]) }, gameManager: { lookForAGameVersion }, configManager: { saveConfig } })

      renderWithProviders(
        <>
          <LookForAVersion />
          <NotificationsOverlay />
        </>,
        { route: "/versions/look-for-a-version" }
      )

      await user.click(screen.getByTitle("Browse"))
      await screen.findByDisplayValue("/external/1.20.4")
      await user.click(screen.getByTitle("Add"))

      expect(await screen.findByText(/only trusts a folder for ten minutes/)).toBeTruthy()
      expect(screen.queryByText(SUCCESS)).toBeNull()
      expect(saveConfig.mock.calls.some(([config]) => (config as ConfigType).gameVersions.length > 0)).toBe(false)
    })

    it("does not say the version was added when the save is refused, names it, and keeps later saves going through", async () => {
      const user = userEvent.setup()
      const saveConfig = vi.fn(refusing("/external/1.20.4"))
      installMockWindowApi({
        utils: { selectFolderDialog: vi.fn(async () => ["/external/1.20.4"]) },
        gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.20.4" })) },
        configManager: { saveConfig }
      })

      renderWithProviders(
        <>
          <LookForAVersion />
          <FavouriteAMod />
          <NotificationsOverlay />
        </>,
        { route: "/versions/look-for-a-version" }
      )

      await user.click(screen.getByTitle("Browse"))
      await screen.findByDisplayValue("/external/1.20.4")
      await user.click(screen.getByTitle("Add"))

      expect(await screen.findByText(/Couldn't keep 1\.20\.4/)).toBeTruthy()
      expect(screen.queryByText(SUCCESS)).toBeNull()

      await user.click(screen.getByRole("button", { name: "favourite a mod" }))
      await waitFor(() => expect(saveConfig.mock.calls.at(-1)?.[0]).toMatchObject({ favMods: [42] }))
      const lastSaved = saveConfig.mock.calls.at(-1)?.[0] as unknown as ConfigType
      expect(lastSaved.gameVersions).toEqual([])
      await act(async () => {})
      expect(screen.queryByText(/Re-pick it on the Config page/)).toBeNull()
    })

    it("says the version was added only once the save has gone through", async () => {
      const user = userEvent.setup()
      let finishSave: (result: SaveConfigResult) => void = () => {}
      const saveConfig = vi.fn(
        (config: ConfigType) =>
          new Promise<SaveConfigResult>((resolve) => {
            if (config.gameVersions.length > 0) finishSave = resolve
            else resolve({ ok: true })
          })
      )
      installMockWindowApi({
        utils: { selectFolderDialog: vi.fn(async () => ["/external/1.20.4"]) },
        gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.20.4" })) },
        configManager: { saveConfig }
      })

      renderWithProviders(
        <>
          <LookForAVersion />
          <NotificationsOverlay />
        </>,
        { route: "/versions/look-for-a-version" }
      )

      await user.click(screen.getByTitle("Browse"))
      await screen.findByDisplayValue("/external/1.20.4")
      await user.click(screen.getByTitle("Add"))
      await waitFor(() => expect(saveConfig.mock.calls.some(([config]) => config.gameVersions.length > 0)).toBe(true))
      expect(screen.queryByText(SUCCESS)).toBeNull()

      await act(async () => finishSave({ ok: true }))
      expect(await screen.findByText(SUCCESS)).toBeTruthy()
    })

    it("takes the version back out when the write fails, so Add works again for the same folder", async () => {
      const user = userEvent.setup()
      let writeFails = true
      const saveConfig = vi.fn(async (config: ConfigType) =>
        writeFails && config.gameVersions.length > 0 ? ({ ok: false, reason: "write-failed" } as SaveConfigResult) : ({ ok: true } as SaveConfigResult)
      )
      installMockWindowApi({
        utils: { selectFolderDialog: vi.fn(async () => ["/external/1.20.4"]) },
        gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.20.4" })) },
        configManager: { saveConfig }
      })

      function ListedVersions(): JSX.Element {
        return (
          <p>
            versions:{" "}
            {useGameVersions()
              .map((gameVersion) => gameVersion.version)
              .join(",") || "none"}
          </p>
        )
      }

      renderWithProviders(
        <>
          <LookForAVersion />
          <ListedVersions />
          <NotificationsOverlay />
        </>,
        { route: "/versions/look-for-a-version" }
      )

      await user.click(screen.getByTitle("Browse"))
      await screen.findByDisplayValue("/external/1.20.4")
      await user.click(screen.getByTitle("Add"))

      expect(await screen.findByText("That VS Version couldn't be saved, so it wasn't added.")).toBeTruthy()
      expect(screen.queryByText(SUCCESS)).toBeNull()
      // What the message says is true: the row is not listed, and the next save does not carry it.
      await screen.findByText("versions: none")
      await waitFor(() => expect(saveConfig.mock.calls.at(-1)?.[0].gameVersions).toEqual([]))

      // The player picks the folder again once the disk works, and Add goes through.
      writeFails = false
      await user.click(screen.getByTitle("Browse"))
      await screen.findByDisplayValue("/external/1.20.4")
      await user.click(screen.getByTitle("Add"))

      expect(await screen.findByText(SUCCESS)).toBeTruthy()
      expect(screen.queryByText("That folder is already in use.")).toBeNull()
      expect(saveConfig.mock.calls.at(-1)?.[0].gameVersions).toHaveLength(1)
    })
  })
})
