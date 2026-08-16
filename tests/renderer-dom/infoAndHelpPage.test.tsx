import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import InfoAndHelpPage from "@renderer/features/info/pages/InfoAndHelpPage"

import { installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * useAppInfo's mount effect awaits getAppVersion/getOs/formatPath in sequence and calls
 * setState after each. Interacting before that chain settles races userEvent's click against
 * those re-renders and the click is silently dropped, so every test waits for the last call
 * in the chain first.
 */
async function waitForAppInfoToSettle(api: MockedBridgeAPI): Promise<void> {
  await waitFor(() => expect(api.pathsManager.formatPath).toHaveBeenCalled())
}

describe("InfoAndHelpPage", () => {
  it("renders the launcher version and OS read from the mocked api", async () => {
    const user = userEvent.setup()

    const api = installMockWindowApi({
      utils: {
        getAppVersion: vi.fn(async () => "9.9.9"),
        getOs: vi.fn(async () => "win32")
      }
    })

    renderWithProviders(<InfoAndHelpPage />, { route: "/info-and-help" })
    await waitForAppInfoToSettle(api)

    // The debug info block starts collapsed; open it before asserting on its contents.
    await user.click(screen.getByText("Debug info"))

    expect(await screen.findByText("RiftLauncher Version - v9.9.9")).toBeTruthy()
    expect(await screen.findByText("OS Type - win32")).toBeTruthy()
  })

  it("opens the logs folder on the file explorer through the app info hook", async () => {
    const user = userEvent.setup()

    const api = installMockWindowApi({
      pathsManager: {
        getCurrentUserDataPath: vi.fn(async () => "/mock/userdata"),
        formatPath: vi.fn(async (parts: string[]) => parts.join("/"))
      }
    })

    renderWithProviders(<InfoAndHelpPage />, { route: "/info-and-help" })
    await waitForAppInfoToSettle(api)

    await user.click(screen.getByText("Debug info"))
    await user.click(await screen.findByText("this folder"))

    expect(api.pathsManager.openPathOnFileExplorer).toHaveBeenCalledWith("/mock/userdata/Logs")
  })

  it("opens the MVL link on the system browser through the shared link hook", async () => {
    const user = userEvent.setup()
    const api = installMockWindowApi()

    renderWithProviders(<InfoAndHelpPage />, { route: "/info-and-help" })
    await waitForAppInfoToSettle(api)

    await user.click(screen.getByTitle("MVL"))

    expect(api.utils.openOnBrowser).toHaveBeenCalledWith("https://mods.vintagestory.at/mvl")
  })
})
