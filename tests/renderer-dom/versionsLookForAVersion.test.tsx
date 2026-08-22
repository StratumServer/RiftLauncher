import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import LookForAVersion from "@renderer/features/versions/pages/LookForAVersion"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("LookForAVersion", () => {
  it("fills the folder and version fields once a version is detected", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      utils: { selectFolderDialog: vi.fn(async () => ["/games/1.20.4"]) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.20.4" })) }
    })

    renderWithProviders(<LookForAVersion />, { route: "/versions/look-for-a-version" })

    await user.click(screen.getByTitle("Browse"))

    expect(await screen.findByDisplayValue("/games/1.20.4")).toBeTruthy()
    expect(screen.getByDisplayValue("1.20.4")).toBeTruthy()
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

    await user.type(screen.getByPlaceholderText("VS Version found"), "   ")
    await user.click(screen.getByTitle("Add"))

    expect(await screen.findByText("You've no folder selected or there is no VS Version installed on the one you've selected!")).toBeTruthy()
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
})
