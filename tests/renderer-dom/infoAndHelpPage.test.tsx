import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import InfoAndHelpPage from "@renderer/features/info/pages/InfoAndHelpPage"
import WhatsNewDialog from "@renderer/components/layout/WhatsNewDialog"
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
   * The "What's new" section (#439) reads through useLatestReleases, which shares one fetch per
   * session with the startup dialog's useWhatsNew. resetWhatsNewCacheForTests is called first
   * because of that sharing: without it, this test could see whichever mock an earlier test in
   * this file already resolved the module's one cached fetch against.
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

  /**
   * The defect #442 shipped: the section read the startup dialog's answer, which is "nothing" on
   * every launch after the first of a version, so a player who came back to read the notes found
   * a heading over an empty space. It has its own fetch and its own selection now.
   */
  it("lists the latest releases on an ordinary launch, with nothing new since the last one seen", async () => {
    const user = userEvent.setup()
    resetWhatsNewCacheForTests()

    const api = installMockWindowApi({
      utils: { getAppVersion: vi.fn(async () => "1.1.0") },
      configManager: { getConfig: vi.fn(async () => createMockConfig({ lastSeenChangelogVersion: "1.1.0" })) },
      netManager: {
        fetchReleaseNotes: vi.fn(
          async () =>
            ({
              ok: true,
              releases: [
                { tag: "1.1.0", name: "1.1.0", body: "- A fix in 1.1.0", prerelease: false, draft: false, publishedAt: "2026-01-02T00:00:00Z" },
                { tag: "1.0.0", name: "1.0.0", body: "- A fix in 1.0.0", prerelease: false, draft: false, publishedAt: "2026-01-01T00:00:00Z" }
              ]
            }) as FetchReleaseNotesResult
        )
      }
    })

    renderWithProviders(<InfoAndHelpPage />, { route: "/info-and-help" })
    await user.click(screen.getByText("What's new"))

    expect(await screen.findByText("A fix in 1.1.0")).toBeTruthy()
    expect(await screen.findByText("A fix in 1.0.0")).toBeTruthy()
    expect(api.netManager.fetchReleaseNotes).toHaveBeenCalledTimes(1)
  })

  it("still lists the releases after the startup dialog was dismissed, on one shared fetch", async () => {
    const user = userEvent.setup()
    resetWhatsNewCacheForTests()

    const api = installMockWindowApi({
      utils: { getAppVersion: vi.fn(async () => "1.1.0") },
      configManager: { getConfig: vi.fn(async () => createMockConfig({ lastSeenChangelogVersion: "1.0.0", moddbVisibilityAnswer: "declined" })) },
      netManager: {
        fetchReleaseNotes: vi.fn(
          async () =>
            ({
              ok: true,
              releases: [
                { tag: "1.1.0", name: "1.1.0", body: "- A fix in 1.1.0", prerelease: false, draft: false, publishedAt: "2026-01-02T00:00:00Z" },
                { tag: "1.0.0", name: "1.0.0", body: "- A fix in 1.0.0", prerelease: false, draft: false, publishedAt: "2026-01-01T00:00:00Z" }
              ]
            }) as FetchReleaseNotesResult
        )
      }
    })

    renderWithProviders(
      <>
        <WhatsNewDialog />
        <InfoAndHelpPage />
      </>,
      { route: "/info-and-help" }
    )

    // The dialog's own window is (1.0.0, 1.1.0], so it shows one release; the section, still
    // collapsed at this point, will show both.
    await screen.findByText("What's new in 1.1.0")
    await user.click(screen.getByRole("button", { name: "Got it" }))
    await waitFor(() => expect(screen.queryByText("What's new in 1.1.0")).toBeNull())

    await user.click(screen.getByText("What's new"))

    expect(await screen.findByText("A fix in 1.1.0")).toBeTruthy()
    expect(await screen.findByText("A fix in 1.0.0")).toBeTruthy()
    // Two consumers, one round trip to GitHub for the whole session.
    expect(api.netManager.fetchReleaseNotes).toHaveBeenCalledTimes(1)
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
  it("keeps its body inside the scroll container instead of fixing a width", async () => {
    const api = installMockWindowApi()

    renderWithProviders(<InfoAndHelpPage />, { route: "/info-and-help" })
    await waitForAppInfoToSettle(api)

    // The page body is the block holding the title. A fixed w-[50rem] overruns the 730px scroll
    // container at 1024x600, and because the block is centred the spill falls on both sides: the
    // title, the Privacy Policy button and "All releases" are clipped with no way to scroll to them.
    const body = screen.getByRole("heading", { level: 1 }).parentElement

    expect(body?.className).toContain("max-w-[50rem]")
    expect(body?.className).toContain("w-full")
    expect(body?.className).not.toMatch(/(^|\s)w-\[50rem\]/)
  })
})
