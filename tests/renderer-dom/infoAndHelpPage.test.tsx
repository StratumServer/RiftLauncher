import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import InfoAndHelpPage from "@renderer/features/info/pages/InfoAndHelpPage"
import { resetWhatsNewCacheForTests } from "@renderer/features/info/hooks/useWhatsNew"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
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
        getOs: vi.fn(async () => "win32" as NodeJS.Platform)
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

  /**
   * The "What's new" section (#439) reads through the same useWhatsNew hook the startup dialog
   * does. resetWhatsNewCacheForTests is called first because that hook caches its answer for the
   * rest of the session: without it, this test could see whichever mock an earlier test in this
   * file already resolved the module's one cached fetch against.
   */
  it("shows the fetched release's notes, collapsed by default, with the releases link", async () => {
    const user = userEvent.setup()
    resetWhatsNewCacheForTests()

    const api = installMockWindowApi({
      utils: { getAppVersion: vi.fn(async () => "1.1.0") },
      configManager: { getConfig: vi.fn(async () => createMockConfig({ lastSeenChangelogVersion: "" })) },
      netManager: {
        fetchReleaseNotes: vi.fn(
          async () =>
            ({
              ok: true,
              releases: [{ tag: "1.1.0", name: "1.1.0", body: "- A notable fix", prerelease: false, draft: false, publishedAt: "2026-01-01T00:00:00Z" }]
            }) as FetchReleaseNotesResult
        )
      }
    })

    renderWithProviders(<InfoAndHelpPage />, { route: "/info-and-help" })

    expect(screen.queryByText("A notable fix")).toBeNull()

    await user.click(screen.getByText("What's new"))

    expect(await screen.findByText("A notable fix")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "All releases" }))
    expect(api.utils.openOnBrowser).toHaveBeenCalledWith("https://github.com/StratumServer/RiftLauncher/releases")
  })

  it("tells the player the notes could not be loaded when the fetch fails, and still offers the releases link", async () => {
    const user = userEvent.setup()
    resetWhatsNewCacheForTests()

    installMockWindowApi({
      utils: { getAppVersion: vi.fn(async () => "1.1.0") },
      configManager: { getConfig: vi.fn(async () => createMockConfig({ lastSeenChangelogVersion: "1.0.0" })) },
      netManager: { fetchReleaseNotes: vi.fn(async () => ({ ok: false, reason: "offline" }) as FetchReleaseNotesResult) }
    })

    renderWithProviders(<InfoAndHelpPage />, { route: "/info-and-help" })
    await user.click(screen.getByText("What's new"))

    expect(await screen.findByText("The release notes could not be loaded right now.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "All releases" })).toBeTruthy()
  })
})
